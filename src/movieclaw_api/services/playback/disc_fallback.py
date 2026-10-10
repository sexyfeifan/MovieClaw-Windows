"""Server optical-disc fallback: read the main title in place, never extract a whole image.

UDF/ISO9660 extents and DVD IFO cells become local FFmpeg subfile/concat inputs.
Only validated disc metadata chooses ranges; network URLs and paths from the disc
never become protocol inputs. Existing HLS session cleanup owns the small concat list.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from movieclaw_api.services.library.bluray import (
    MPLS_CLOCK_HZ,
    MplsParseError,
    parse_mpls_playlist,
    read_clpi_entry_points,
    select_main_playlist,
)
from movieclaw_api.services.library.udf import UDFError, UDFReader

logger = logging.getLogger(__name__)
SECTOR = 2048
SMALL_LIMIT = 16 << 20


@dataclass(frozen=True)
class ImageEntry:
    name: str
    is_dir: bool
    ranges: tuple[tuple[int, int], ...]


class ISO9660Reader:
    """Read-only ISO9660 fallback for DVD images without a UDF bridge."""

    def __init__(self, fh: BinaryIO):
        self.fh = fh
        fh.seek(0, 2)
        self.image_size = fh.tell()
        self.root = None
        for sector in range(16, 80):
            data = self._read(sector * SECTOR, SECTOR)
            if data[1:6] != b"CD001":
                continue
            if data[0] == 1:
                self.root = self._entry(data[156:190], "/")
                break
            if data[0] == 255:
                break
        if self.root is None:
            raise UDFError("镜像没有 UDF 或 ISO9660 卷")

    def _read(self, offset, length):
        if offset < 0 or length < 0 or offset + length > self.image_size:
            raise UDFError("ISO9660 数据越过镜像末尾")
        self.fh.seek(offset)
        data = self.fh.read(length)
        if len(data) != length:
            raise UDFError("ISO9660 数据不完整")
        return data

    def _entry(self, record, name=None):
        if len(record) < 34:
            raise UDFError("ISO9660 目录记录不完整")
        if record[25] & 0x80:
            raise UDFError("ISO9660 多扩展区记录暂不可读")
        length = int.from_bytes(record[10:14], "little")
        offset = (int.from_bytes(record[2:6], "little") + record[1]) * SECTOR
        if offset + length > self.image_size:
            raise UDFError("ISO9660 文件范围越界")
        filename = name or record[33 : 33 + record[32]].decode("ascii", "strict").split(";")[0]
        return ImageEntry(filename, bool(record[25] & 2), ((offset, length),))

    def list(self, path):
        entry = self.root
        for component in path:
            entry = next(
                (
                    item
                    for item in self._list(entry)
                    if item.is_dir and item.name.upper() == component.upper()
                ),
                None,
            )
            if entry is None:
                raise UDFError("ISO9660 目录不存在")
        return self._list(entry)

    def _list(self, entry):
        data = self.read(entry, 8 << 20)
        result = []
        position = 0
        while position < len(data):
            length = data[position]
            if not length:
                position = (position // SECTOR + 1) * SECTOR
                continue
            record = data[position : position + length]
            if len(record) != length or length < 34:
                raise UDFError("ISO9660 目录记录越界")
            if record[33:34] not in (b"\0", b"\1"):
                result.append(self._entry(record))
            position += length
        return result

    def size(self, entry):
        return sum(length for _, length in entry.ranges)

    def read(self, entry, limit):
        if self.size(entry) > limit:
            raise UDFError("ISO9660 小文件过大")
        return b"".join(self._read(offset, length) for offset, length in entry.ranges)

    def physical_ranges(self, entry):
        return entry.ranges


def extent_url(path: Path, ranges: tuple[tuple[int, int], ...]) -> str:
    """Local seekable byte ranges. The FFmpeg protocol list is restricted separately."""
    name = str(path.resolve())
    if any(char in name for char in ("|", "\r", "\n", "\0")) or not ranges or len(ranges) > 4096:
        raise UDFError("光盘路径或媒体分配描述符不可用于取流")
    size = path.stat().st_size
    urls = []
    for offset, length in ranges:
        if offset < 0 or length <= 0 or offset + length > size:
            raise UDFError("光盘媒体范围越界")
        urls.append(f"subfile,,start,{offset},end,{offset + length},,:{name}")
    return urls[0] if len(urls) == 1 else "concat:" + "|".join(urls)


def _slice_ranges(parts, start, length):
    result = []
    for path, offset, size in parts:
        if start >= size:
            start -= size
            continue
        count = min(length, size - start)
        result.append((path, offset + start, count))
        length -= count
        start = 0
        if not length:
            return result
    raise UDFError("DVD cell 越过标题 VOB 末尾")


def _parts_url(parts):
    urls = [extent_url(path, ((offset, size),)) for path, offset, size in parts]
    return urls[0] if len(urls) == 1 else "concat:" + "|".join(urls)


def _dvd_time(value):
    if len(value) != 4:
        raise UDFError("DVD 时长字段不完整")

    def bcd(byte):
        if (byte & 15) > 9 or byte >> 4 > 9:
            raise UDFError("DVD 时长 BCD 无效")
        return (byte >> 4) * 10 + (byte & 15)

    hours, minutes, seconds = map(bcd, value[:3])
    if minutes >= 60 or seconds >= 60:
        raise UDFError("DVD 时长分秒无效")
    frames = bcd(value[3] & 0x3F)
    frame_rate = {1: 25, 3: 30000 / 1001}.get(value[3] >> 6)
    if (frame_rate is None and frames) or (frame_rate and frames >= round(frame_rate)):
        raise UDFError("DVD 时长帧数无效")
    return hours * 3600 + minutes * 60 + seconds + (frames / frame_rate if frame_rate else 0)


def _dvd_cells(data):
    """Choose a validated linear main PGC; interleaved angles need libdvdnav."""
    if len(data) < 0xD0 or data[:12] != b"DVDVIDEO-VTS":
        raise UDFError("DVD 主标题 IFO 无效")
    table = int.from_bytes(data[0xCC:0xD0], "big") * SECTOR
    if table + 8 > len(data):
        raise UDFError("DVD PGC 表越界")
    end = table + int.from_bytes(data[table + 4 : table + 8], "big") + 1
    count = int.from_bytes(data[table : table + 2], "big")
    if not 0 < count <= 999 or end > len(data) or table + 8 + count * 8 > end:
        raise UDFError("DVD PGC 声明范围越界")
    offsets = []
    for index in range(count):
        row = table + 8 + index * 8
        pgc = table + int.from_bytes(data[row + 4 : row + 8], "big")
        if pgc < table + 8 + count * 8 or pgc + 0xEC > end:
            raise UDFError("DVD PGC 条目越界")
        offsets.append(pgc)
    candidates, unsupported_durations = [], []
    for pgc in offsets:
        local_end = min((offset for offset in offsets if offset > pgc), default=end)
        cell_count = data[pgc + 3]
        cells = pgc + int.from_bytes(data[pgc + 0xE8 : pgc + 0xEA], "big")
        if not cell_count:
            continue
        if cells < pgc + 0xEC or cells + cell_count * 24 > local_end:
            raise UDFError("DVD cell 表越界")
        result = []
        for index in range(cell_count):
            cell = data[cells + index * 24 : cells + (index + 1) * 24]
            if ((cell[0] >> 4) & 3) == 1 or cell[0] & 4:
                unsupported_durations.append(_dvd_time(data[pgc + 4 : pgc + 8]))
                result = []
                break
            start, last = int.from_bytes(cell[8:12], "big"), int.from_bytes(cell[20:24], "big")
            seconds = _dvd_time(cell[4:8])
            if last < start or seconds <= 0:
                raise UDFError("DVD cell 范围或时长无效")
            result.append((start * SECTOR, (last - start + 1) * SECTOR, seconds))
        if result:
            candidates.append((_dvd_time(data[pgc + 4 : pgc + 8]), result))
    best = max(candidates, key=lambda item: item[0]) if candidates else None
    if unsupported_durations and (best is None or max(unsupported_durations) >= best[0]):
        raise UDFError("DVD 多角度或交织主标题需要 libdvdnav，当前不可线性读取")
    if best is None:
        raise UDFError("DVD 主标题没有播放 cell")
    return best[1]


def _dvd_source(root, entries, read, parts):
    import re

    from movieclaw_api.services.playback.disc_source import DiscClip, DiscSource
    from movieclaw_api.services.reels.disc_index import _title_set_numbers

    totals = {}
    for name, entry in entries.items():
        match = re.fullmatch(r"VTS_(\d{2})_[1-9]\.VOB", name)
        if match:
            vts = int(match[1])
            totals[vts] = totals.get(vts, 0) + sum(size for _, _, size in parts(entry))
    try:
        listed = _title_set_numbers(read(entries["VIDEO_TS.IFO"]))
        totals = {vts: size for vts, size in totals.items() if vts in listed} or totals
    except (KeyError, ValueError, OSError):
        pass
    if not totals:
        raise UDFError("DVD 没有标题 VOB")
    title = min(totals, key=lambda vts: (-totals[vts], vts))
    cells = _dvd_cells(read(entries[f"VTS_{title:02d}_0.IFO"]))
    title_parts = []
    for number in range(1, 10):
        entry = entries.get(f"VTS_{title:02d}_{number}.VOB")
        if entry is not None:
            title_parts.extend(parts(entry))
    source = DiscSource(
        root,
        f"VTS_{title:02d}_0.IFO",
        tuple(
            DiscClip(
                f"cell{index}",
                root,
                0,
                round(seconds * MPLS_CLOCK_HZ),
                input_url=_parts_url(_slice_ranges(title_parts, start, length)),
                timed=False,
            )
            for index, (start, length, seconds) in enumerate(cells)
        ),
        keyframe_times=(),
        virtual=True,
        dependencies=tuple(
            entry
            for name, entry in entries.items()
            if isinstance(entry, Path)
            and (name == "VIDEO_TS.IFO" or name.startswith(f"VTS_{title:02d}_"))
        ),
    )
    from dataclasses import replace

    payload = _probe_title_data(source.clips[0].input_url, source.probe_fingerprint)
    return replace(source, stream_ids=_dvd_stream_ids(payload))


def _dvd_stream_ids(payload):
    """Keep first-title media order but bind each concat stream to its actual PS ID."""
    if not payload:
        raise UDFError("DVD 主标题流无法探测，不能建立音轨映射")
    result = []
    for stream in payload.get("streams", []):
        if stream.get("codec_type") not in {"video", "audio", "subtitle"}:
            continue  # navigation/data packets are not selectable media tracks
        raw = stream.get("id")
        try:
            stream_id = int(raw, 0) if isinstance(raw, str) else raw
        except ValueError as exc:
            raise UDFError("DVD 主标题流 ID 无效，不能建立音轨映射") from exc
        if type(stream_id) is not int or not 0 <= stream_id <= 0x7FFFFFFF or stream_id in result:
            raise UDFError("DVD 主标题流 ID 缺失或重复，不能建立音轨映射")
        result.append(stream_id)
    if not result or len(result) > 64:
        raise UDFError("DVD 主标题没有可映射的媒体流")
    return tuple(result)


def dvd_folder_source(root: Path):
    folder = next(
        (path for path in root.iterdir() if path.is_dir() and path.name.upper() == "VIDEO_TS"), None
    )
    if folder is None:
        raise UDFError("DVD 缺少 VIDEO_TS 目录")
    entries = {path.name.upper(): path for path in folder.iterdir() if path.is_file()}

    def read(path):
        if path.stat().st_size > SMALL_LIMIT:
            raise UDFError("DVD IFO 过大")
        return path.read_bytes()

    return _dvd_source(root, entries, read, lambda path: [(path, 0, path.stat().st_size)])


def iso_source(path: Path):
    from movieclaw_api.services.playback.disc_source import DiscClip, DiscSource

    with path.open("rb") as fh:
        try:
            reader = UDFReader(fh)
        except UDFError:
            reader = ISO9660Reader(fh)
        top = {entry.name.upper(): entry for entry in reader.list([])}
        if "VIDEO_TS" in top:
            entries = {
                entry.name.upper(): entry for entry in reader.list(["VIDEO_TS"]) if not entry.is_dir
            }
            return _dvd_source(
                path,
                entries,
                lambda entry: reader.read(entry, SMALL_LIMIT),
                lambda entry: [
                    (path, offset, size) for offset, size in reader.physical_ranges(entry)
                ],
            )
        if "BDMV" not in top:
            raise UDFError("镜像没有 BDMV 或 VIDEO_TS")

        def files(folder, suffix):
            return {
                entry.name.rsplit(".", 1)[0]: entry
                for entry in reader.list(["BDMV", folder])
                if not entry.is_dir and entry.name.lower().endswith(suffix)
            }

        streams = files("STREAM", ".m2ts")
        playlists = []
        for name, entry in files("PLAYLIST", ".mpls").items():
            try:
                playlists.append(
                    parse_mpls_playlist(reader.read(entry, SMALL_LIMIT), path=Path(name + ".mpls"))
                )
            except (UDFError, MplsParseError):
                continue
        playlist = select_main_playlist(playlists, set(streams))
        if playlist is None:
            raise UDFError("镜像主播放列表不可读")
        clips = tuple(
            DiscClip(
                item.clip_id,
                path,
                item.in_time,
                item.out_time,
                input_url=extent_url(path, reader.physical_ranges(streams[item.clip_id])),
            )
            for item in playlist.items
        )
        times, base = [], 0.0
        try:
            clpis = files("CLIPINF", ".clpi")
            for item in playlist.items:
                points = read_clpi_entry_points(reader.read(clpis[item.clip_id], SMALL_LIMIT))
                if not points:
                    times = []
                    break
                times.extend(
                    base + max(0, pts - item.in_time) / MPLS_CLOCK_HZ
                    for pts, _ in points
                    if item.in_time <= pts < item.out_time
                )
                base += (item.out_time - item.in_time) / MPLS_CLOCK_HZ
        except (KeyError, UDFError):
            times = []
        return DiscSource(
            path, playlist.path.name, clips, keyframe_times=tuple(times), virtual=True
        )


def main_title_file(file, source):
    """Use bounded first-title stream probing rather than ffprobe's whole-image guess."""
    if source is None or not source.virtual:
        return file
    spec = _probe_title(source.clips[0].input_url, source.probe_fingerprint)
    if spec is None:
        return file
    return file.model_copy(
        update={
            "resolution": spec.resolution,
            "video_codec": spec.video_codec,
            "hdr": spec.hdr,
            "bit_depth": spec.bit_depth,
            "color_space": spec.color_space,
            "frame_rate": spec.frame_rate,
            "audio_streams": spec.audio_streams,
            "subtitle_streams": spec.subtitle_streams,
            "duration_seconds": round(source.duration_s),
        }
    )


from functools import lru_cache  # noqa: E402


@lru_cache(maxsize=128)
def _probe_title(url, fingerprint):
    from movieclaw_api.services.media_probe import _parse_probe

    payload = _probe_title_data(url, fingerprint)
    return _parse_probe(payload) if payload else None


@lru_cache(maxsize=128)
def _probe_title_data(url, fingerprint):
    import json
    import subprocess

    try:
        response = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,subfile,concat",
                "-probesize",
                "4194304",
                "-analyzeduration",
                "3000000",
                "-show_streams",
                "-of",
                "json",
                url,
            ],
            capture_output=True,
            timeout=10,
        )
        if response.returncode:
            return None
        return json.loads(response.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
