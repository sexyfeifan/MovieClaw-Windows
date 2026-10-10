"""Optical-disc fallback contracts with synthetic UDF/DVD and real FFmpeg media."""

from __future__ import annotations

import io
import json
import shutil
import subprocess

import pytest
from tests.api.test_bluray_clpi import _mpls
from tests.api.test_reels_disc_index import _UdfBuilder, _vmg_ifo

from movieclaw_api.services.library.udf import UDFError, UDFReader
from movieclaw_api.services.playback.disc_fallback import (
    _dvd_cells,
    dvd_folder_source,
    extent_url,
    iso_source,
    main_title_file,
)
from movieclaw_api.services.playback.ffmpeg_args import build_hls_command
from movieclaw_db.models import LibraryFile
from movieclaw_playback.capability import universal_capability
from movieclaw_playback.decide import (
    MediaProfile,
    PlaybackPlan,
    PlaybackPolicy,
    PlaybackTier,
    decide_playback,
)

S = 2048


def vts_ifo(cells):
    data = bytearray(4 * S)
    data[:12] = b"DVDVIDEO-VTS"
    data[0xCC:0xD0] = (1).to_bytes(4, "big")
    table, pgc = S, S + 16
    data[table : table + 2] = (1).to_bytes(2, "big")
    data[table + 4 : table + 8] = (len(data) - table - 1).to_bytes(4, "big")
    data[table + 12 : table + 16] = (16).to_bytes(4, "big")
    data[pgc + 3] = len(cells)
    data[pgc + 6] = 4
    data[pgc + 0xE8 : pgc + 0xEA] = (0xEC).to_bytes(2, "big")
    for index, (first, last, seconds, flags) in enumerate(cells):
        offset = pgc + 0xEC + index * 24
        data[offset] = flags
        data[offset + 6] = seconds
        data[offset + 7] = 0xC0
        data[offset + 8 : offset + 12] = first.to_bytes(4, "big")
        data[offset + 20 : offset + 24] = last.to_bytes(4, "big")
    return bytes(data)


@pytest.fixture(scope="module")
def real_media(tmp_path_factory):
    assert shutil.which("ffmpeg") and shutil.which("ffprobe"), (
        "disc contract needs existing FFmpeg runtime"
    )
    root = tmp_path_factory.mktemp("disc-media")
    result = {}
    for codec, suffix, mux in [("h264", "m2ts", "mpegts"), ("mpeg2video", "VOB", "dvd")]:
        path = root / ("clip." + suffix)
        video_codec = "libx264" if codec == "h264" else codec
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=320x240:r=25",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=500:sample_rate=48000",
                "-t",
                "4",
                "-c:v",
                video_codec,
                "-g",
                "25",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "ac3",
                "-b:a",
                "192k",
                "-f",
                mux,
                str(path),
            ],
            check=True,
            capture_output=True,
            timeout=20,
        )
        result[codec] = path.read_bytes()
    from tests.playback.pgs_sup import make_sup

    sup = root / "caption.sup"
    sup.write_bytes(make_sup(start_s=2.4, end_s=4.4))
    pgs = root / "captioned.m2ts"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(root / "clip.m2ts"),
            "-i",
            str(sup),
            "-map",
            "0",
            "-map",
            "1",
            "-c",
            "copy",
            "-f",
            "mpegts",
            str(pgs),
        ],
        check=True,
        capture_output=True,
        timeout=20,
    )
    result["pgs"] = pgs.read_bytes()
    return result


def test_iso_ranges_are_bounded_and_require_complete_allocation():
    image = _UdfBuilder(metadata=True).build({"movie.bin": (b"tiny", 1 << 30)})
    reader = UDFReader(io.BytesIO(image))
    with pytest.raises(UDFError, match="不完整"):
        reader.physical_ranges(reader.list([])[0])


def test_dvd_cell_selection_rejects_interleaved_angles_and_out_of_bounds_table():
    data = vts_ifo([(0, 5, 1, 0x50), (6, 11, 1, 0x90), (12, 17, 1, 0xD0), (18, 23, 1, 0)])
    with pytest.raises(UDFError, match="多角度"):
        _dvd_cells(data)
    broken = bytearray(data)
    broken[S + 16 + 0xE8 : S + 16 + 0xEA] = (0xFFFF).to_bytes(2, "big")
    with pytest.raises(UDFError, match="cell 表越界"):
        _dvd_cells(bytes(broken))


def test_extent_url_refuses_protocol_delimiters_and_out_of_file_ranges(tmp_path):
    path = tmp_path / "bad|movie.iso"
    path.write_bytes(b"abc")
    with pytest.raises(UDFError):
        extent_url(path, ((0, 3),))
    path = tmp_path / "good.iso"
    path.write_bytes(b"abc")
    with pytest.raises(UDFError):
        extent_url(path, ((2, 3),))


@pytest.mark.parametrize("container", ["iso", "dvd"])
def test_parsed_server_title_remuxes_without_claiming_a_client_disc_reader(container):
    decision = decide_playback(
        MediaProfile(
            file_id=1,
            container=container,
            video_codec="mpeg2video",
            disc_clips=1,
            dvd_folder=container == "dvd",
            server_disc_available=True,
        ),
        universal_capability(),
        PlaybackPolicy(),
    )
    assert isinstance(decision, PlaybackPlan)
    assert decision.tier is PlaybackTier.REMUX and decision.disc is None
    assert decision.container == ("hls-ts" if container == "dvd" else "hls-fmp4")


@pytest.mark.parametrize("kind", ["bdmv-iso", "dvd-iso", "dvd-folder", "bdmv-folder"])
@pytest.mark.integration
def test_synthetic_disc_main_title_becomes_real_hls_with_audio_and_known_duration(
    tmp_path, real_media, kind
):
    if kind.startswith("bdmv"):
        structure = {
            "BDMV": {
                "PLAYLIST": {"00001.mpls": _mpls(("00001", 63000, 243000))},
                "STREAM": {"00001.m2ts": real_media["h264"]},
            }
        }
    else:
        payload = real_media["mpeg2video"]
        payload = payload.ljust(-(-len(payload) // S) * S, b"\0")
        midpoint = (len(payload) // S // 2) * S
        structure = {
            "VIDEO_TS": {
                "VIDEO_TS.IFO": _vmg_ifo([1]),
                "VTS_01_0.IFO": vts_ifo([(0, len(payload) // S - 1, 4, 0)]),
                "VTS_01_1.VOB": payload[:midpoint],
                "VTS_01_2.VOB": payload[midpoint:],
            }
        }
    if kind.endswith("iso"):
        path = tmp_path / "movie.iso"
        path.write_bytes(_UdfBuilder(metadata=True).build(structure))
        source = iso_source(path)
        container = "iso"
    else:
        path = tmp_path / "movie"
        for parent, children in structure.items():
            for name, payload in children.items():
                if isinstance(payload, dict):
                    for filename, content in payload.items():
                        target = path / parent / name / filename
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(content)
                else:
                    target = path / parent / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(payload)
        if kind == "dvd-folder":
            source = dvd_folder_source(path)
            container = "dvd"
        else:
            from movieclaw_api.services.playback.disc_source import disc_source_for_file

            source = disc_source_for_file(
                LibraryFile(library_id=1, file_path=str(path), container="bluray")
            )
            container = "bluray"
    assert source.duration_s == 4
    row = LibraryFile(
        id=1,
        library_id=1,
        file_path=str(path),
        container=container,
        video_codec="h264" if kind.startswith("bdmv") else "mpeg2video",
    )
    adapted = main_title_file(row, source)
    if source.virtual:
        assert adapted.audio_streams[0]["codec"] == "ac3"
    from dataclasses import replace

    from movieclaw_playback.profile import media_profile_from_file

    profile = replace(
        media_profile_from_file(adapted, disc_clips=len(source.clips)), server_disc_available=True
    )
    decision = decide_playback(profile, universal_capability(), PlaybackPolicy())
    # Folder BDMV single-clip is already direct playable; exercise its concat path too.
    if decision.tier is PlaybackTier.DIRECT_PLAY:
        decision = replace(decision, tier=PlaybackTier.REMUX, container="hls-fmp4")
    session_dir = tmp_path / "session"
    session_dir.mkdir()
    source_path = session_dir / "source.concat"
    source_path.write_text(source.concat_list())
    command = build_hls_command(
        decision,
        source_path=str(source_path),
        session_dir=session_dir,
        input_format="concat",
        start_number=0,
    )
    assert "file,subfile,concat" in command.argv
    assert "-c:v" in command.argv and command.argv[command.argv.index("-c:v") + 1] == "copy"
    completed = subprocess.run(command.argv, capture_output=True, timeout=20)
    assert completed.returncode == 0, completed.stderr.decode(errors="replace")
    playlist = command.playlist_path.read_text()
    assert "#EXTINF" in playlist and "#EXT-X-ENDLIST" in playlist
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(command.playlist_path)],
        capture_output=True,
        timeout=10,
        check=True,
    )
    streams = json.loads(probe.stdout)["streams"]
    assert any(stream["codec_type"] == "video" for stream in streams)
    if source.virtual:
        assert any(stream["codec_type"] == "audio" for stream in streams)


def iso9660_image(structure):
    sectors, cursor = {}, 20

    def record(block, size, name, is_dir=False):
        encoded = (
            name
            if isinstance(name, bytes)
            else (name + (";1" if not is_dir else "")).encode("ascii")
        )
        data = bytearray(33 + len(encoded) + (len(encoded) % 2 == 0))
        data[0] = len(data)
        data[2:6], data[6:10] = block.to_bytes(4, "little"), block.to_bytes(4, "big")
        data[10:14], data[14:18] = size.to_bytes(4, "little"), size.to_bytes(4, "big")
        data[25], data[32] = 2 if is_dir else 0, len(encoded)
        data[28:30], data[30:32] = b"\1\0", b"\0\1"
        data[33 : 33 + len(encoded)] = encoded
        return bytes(data)

    def tree(items):
        nonlocal cursor
        block = cursor
        cursor += 1
        listing = record(block, S, b"\0", True) + record(block, S, b"\1", True)
        for name, value in items.items():
            if isinstance(value, dict):
                child = tree(value)
                listing += record(child, S, name, True)
            else:
                child = cursor
                cursor += -(-len(value) // S)
                sectors[child] = value
                listing += record(child, len(value), name)
        assert len(listing) <= S
        sectors[block] = listing.ljust(S, b"\0")
        return block

    root = tree(structure)
    pvd = bytearray(S)
    pvd[:7] = b"\1CD001\1"
    pvd[156:190] = record(root, S, b"\0", True)
    sectors[16] = bytes(pvd)
    sectors[17] = b"\xffCD001\1".ljust(S, b"\0")
    image = bytearray(max(300, cursor + 1) * S)
    for block, data in sectors.items():
        image[block * S : block * S + len(data)] = data
    return bytes(image)


class FragmentedUdf(_UdfBuilder):
    def file(self, data, *, size=None):
        if len(data) < 2 * S:
            return super().file(data, size=size)
        ads = bytearray()
        for part in (data[:S], data[S:]):
            phys = self._phys_block(-(-len(part) // S))
            self._write_phys(phys, part)
            self._phys_block(2)  # physically noncontiguous allocations
            ads += len(part).to_bytes(4, "little") + phys.to_bytes(4, "little")
            if self.metadata:
                ads += b"\0" * 8
        block = self._meta_block()
        self._write_meta(block, self._fe(size or len(data), bytes(ads), 1 if self.metadata else 0))
        return block


@pytest.mark.parametrize("layout", ["iso9660-dvd", "fragmented-udf-bdmv"])
@pytest.mark.integration
def test_iso_layouts_probe_real_media_without_extracting_image(tmp_path, real_media, layout):
    if layout == "iso9660-dvd":
        payload = real_media["mpeg2video"]
        payload = payload.ljust(-(-len(payload) // S) * S, b"\0")
        image = iso9660_image(
            {
                "VIDEO_TS": {
                    "VIDEO_TS.IFO": _vmg_ifo([1]),
                    "VTS_01_0.IFO": vts_ifo([(0, len(payload) // S - 1, 4, 0)]),
                    "VTS_01_1.VOB": payload,
                }
            }
        )
    else:
        image = FragmentedUdf(metadata=True).build(
            {
                "BDMV": {
                    "PLAYLIST": {"00001.mpls": _mpls(("00001", 63000, 243000))},
                    "STREAM": {"00001.m2ts": real_media["h264"]},
                }
            }
        )
    path = tmp_path / "disc.iso"
    path.write_bytes(image)
    source = iso_source(path)
    assert source.duration_s == 4
    if layout.startswith("fragmented"):
        assert "concat:subfile" in source.clips[0].input_url
    probe = main_title_file(LibraryFile(id=90, file_path=str(path), container="iso"), source)
    assert probe.video_codec in {"h264", "mpeg2video"}
    assert probe.audio_streams[0]["codec"] == "ac3"
    assert sorted(entry.name for entry in tmp_path.iterdir()) == ["disc.iso"]


def test_dvd_ifo_validates_declared_table_bcd_and_ntsc_frames():
    data = bytearray(vts_ifo([(0, 3, 1, 0)]))
    data[S + 4 : S + 8] = (15).to_bytes(4, "big")
    with pytest.raises(UDFError, match="条目越界"):
        _dvd_cells(data)
    data = bytearray(vts_ifo([(0, 3, 1, 0)]))
    data[S + 16 + 0xEC + 6] = 0x60
    with pytest.raises(UDFError, match="分秒无效"):
        _dvd_cells(data)
    data[S + 16 + 0xEC + 6] = 1
    data[S + 16 + 0xEC + 7] = 0xE9
    assert _dvd_cells(data)[0][2] == pytest.approx(1 + 29 * 1001 / 30000)


def test_udf_sparse_allocations_are_not_treated_as_media_bytes():
    data = bytearray(_UdfBuilder(metadata=False).build({"movie.bin": b"a" * S}))
    reader = UDFReader(io.BytesIO(data))
    entry = reader.list([])[0]
    offset = (300 + entry.icb_block) * S + 176
    data[offset : offset + 4] = (S | 1 << 30).to_bytes(4, "little")
    reader = UDFReader(io.BytesIO(data))
    with pytest.raises(UDFError, match="稀疏"):
        reader.physical_ranges(reader.list([])[0])


@pytest.mark.integration
def test_iso_pgs_extracts_from_logical_title_and_invalidates_cache_on_image_change(
    tmp_path, monkeypatch, real_media
):
    from movieclaw_api.services import media_extract

    image = _UdfBuilder(metadata=True).build(
        {
            "BDMV": {
                "PLAYLIST": {"00001.mpls": _mpls(("00001", 63000, 243000))},
                "STREAM": {"00001.m2ts": real_media["pgs"]},
            }
        }
    )
    path = tmp_path / "subtitle.iso"
    path.write_bytes(image)
    file = LibraryFile(id=94, file_path=str(path), container="iso")
    file = main_title_file(file, iso_source(path))
    assert file.subtitle_streams[0]["codec"] == "hdmv_pgs_subtitle"
    monkeypatch.setattr(media_extract, "cache_dir", lambda: tmp_path / "subs")
    first = media_extract.extract_track(file, 0)
    assert first and first.format == "sup" and first.path.read_bytes().startswith(b"PG")
    assert media_extract.extract_track(file, 0).path == first.path
    import os

    stamp = path.stat().st_mtime_ns + 1_000_000_000
    os.utime(path, ns=(stamp, stamp))
    second = media_extract.extract_track(file, 0)
    assert second and second.path != first.path and second.path.read_bytes().startswith(b"PG")
    assert len(list((tmp_path / "subs").glob("*.concat"))) == 2
    assert not list((tmp_path / "subs").glob("*.tmp"))


@pytest.fixture(scope="module")
def reordered_dvd(tmp_path_factory):
    from tests.playback.pgs_sup import make_sup

    root = tmp_path_factory.mktemp("dvd-stream-id")
    subtitle = root / "caption.sup"
    subtitle.write_bytes(
        make_sup(video_w=320, video_h=240, x=20, y=180, w=100, h=20, start_s=0.5, end_s=1.5)
    )
    original = root / "original.VOB"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=blue:s=320x240:r=25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000",
            "-i",
            str(subtitle),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-map",
            "3:s",
            "-t",
            "2",
            "-c:v",
            "mpeg2video",
            "-g",
            "25",
            "-c:a",
            "ac3",
            "-b:a",
            "192k",
            "-c:s",
            "dvdsub",
            "-f",
            "dvd",
            str(original),
        ],
        check=True,
        capture_output=True,
        timeout=20,
    )
    data = original.read_bytes()
    assert len(data) % S == 0
    chunks = [data[offset : offset + S] for offset in range(0, len(data), S)]

    def private_id(chunk):
        position = chunk.find(b"\0\0\1\xbd")
        return chunk[position + 9 + chunk[position + 8]] if position >= 0 else None

    audio81 = next(index for index, chunk in enumerate(chunks) if private_id(chunk) == 0x81)
    # A valid PS contains the same packets/PTS; discovery order changes because
    # the 0x81 audio PES now precedes 0x80, instead of changing audio identities.
    reordered = chunks.copy()
    reordered.insert(1, reordered.pop(audio81))
    second = root / "reordered.VOB"
    second.write_bytes(b"".join(reordered))

    def streams(path):
        response = subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
            check=True,
            capture_output=True,
            timeout=10,
        )
        return json.loads(response.stdout)["streams"]

    first_audio = [s["id"] for s in streams(original) if s["codec_type"] == "audio"]
    second_audio = [s["id"] for s in streams(second) if s["codec_type"] == "audio"]
    assert first_audio == ["0x80", "0x81"] and second_audio == ["0x81", "0x80"]
    return original.read_bytes(), second.read_bytes()


def reordered_dvd_structure(media):
    first, second = media
    count = len(first) // S
    return {
        "VIDEO_TS": {
            "VIDEO_TS.IFO": _vmg_ifo([1]),
            "VTS_01_0.IFO": vts_ifo(
                [(0, count - 1, 2, 0), (count, count + len(second) // S - 1, 2, 0)]
            ),
            "VTS_01_1.VOB": first,
            "VTS_01_2.VOB": second,
        }
    }


def tone_frequency(samples, start, end, rate=8000):
    part = samples[round(start * rate) : round(end * rate)]
    crossings = sum(left <= 0 < right for left, right in zip(part[:-1], part[1:], strict=True))
    return crossings / (len(part) / rate)


@pytest.mark.parametrize("audio_index,hz", [(0, 440), (1, 880)])
@pytest.mark.integration
def test_dvd_real_ps_discovery_order_cannot_swap_selected_audio_across_cells(
    tmp_path, monkeypatch, reordered_dvd, audio_index, hz
):
    import struct
    from dataclasses import replace

    from movieclaw_playback.profile import media_profile_from_file

    root = tmp_path / "movie"
    for folder, entries in reordered_dvd_structure(reordered_dvd).items():
        for name, data in entries.items():
            target = root / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    source = dvd_folder_source(root)
    assert len(source.clips) == 2 and source.duration_s == 4
    assert source.stream_ids and all(type(value) is int for value in source.stream_ids)
    row = main_title_file(LibraryFile(id=99, file_path=str(root), container="dvd"), source)
    assert row.duration_seconds == 4 and len(row.audio_streams) == 2
    assert row.subtitle_streams[0]["codec"] == "dvd_subtitle"
    from movieclaw_api.services import media_extract

    monkeypatch.setattr(media_extract, "cache_dir", lambda: tmp_path / "subs")
    adapted, _args, subtitle_input, _suffix = media_extract._disc_input(row)
    assert subtitle_input.read_text() == source.concat_list()
    assert adapted.duration_seconds == row.duration_seconds
    assert adapted.subtitle_streams == row.subtitle_streams
    legacy = replace(source, stream_ids=())
    assert legacy.fingerprint != source.fingerprint  # old ordinal-based cache is stale
    assert legacy.probe_fingerprint == source.probe_fingerprint
    profile = replace(media_profile_from_file(row, disc_clips=2), server_disc_available=True)
    decision = decide_playback(
        profile, universal_capability(), PlaybackPolicy(), preferred_audio=f"embedded:{audio_index}"
    )
    assert decision.audio.track_ref == f"embedded:{audio_index}"
    assert decision.subtitles == ()  # actual DVD bitmap is honestly unavailable
    session_dir = tmp_path / "session"
    session_dir.mkdir()
    manifest = session_dir / "source.concat"
    manifest.write_text(source.concat_list())
    assert manifest.read_text().count("exact_stream_id") == len(source.stream_ids)
    command = build_hls_command(
        decision,
        source_path=str(manifest),
        session_dir=session_dir,
        input_format="concat",
        start_number=0,
    )
    proc = subprocess.run(command.argv, capture_output=True, timeout=20)
    assert proc.returncode == 0, proc.stderr.decode(errors="replace")[-1000:]
    decoded = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(command.playlist_path),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "-",
        ],
        check=True,
        capture_output=True,
        timeout=15,
    ).stdout
    samples = struct.unpack("<" + "f" * (len(decoded) // 4), decoded)
    assert len(samples) / 8000 == pytest.approx(4, abs=0.15)
    assert tone_frequency(samples, 0.5, 1.5) == pytest.approx(hz, abs=20)
    assert tone_frequency(samples, 2.5, 3.5) == pytest.approx(hz, abs=20)


@pytest.mark.parametrize(
    "streams",
    [
        [{"codec_type": "audio"}],
        [{"codec_type": "audio", "id": "unknown"}],
        [{"codec_type": "audio", "id": "0x80"}, {"codec_type": "audio", "id": "0x80"}],
        [{"codec_type": "audio", "id": True}],
    ],
)
def test_dvd_stream_contract_never_invents_missing_or_duplicate_ids(streams):
    from movieclaw_api.services.playback.disc_fallback import _dvd_stream_ids

    with pytest.raises(UDFError, match="ID"):
        _dvd_stream_ids({"streams": streams})
