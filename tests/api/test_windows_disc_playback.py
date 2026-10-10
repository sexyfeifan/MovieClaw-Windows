"""Windows disc negotiation runs through the real HTTP stack and real FFmpeg."""

from __future__ import annotations

from urllib.parse import urlsplit

import pytest
from tests.api.test_auth import client as client  # noqa: F401
from tests.api.test_bluray_clpi import _mpls
from tests.api.test_reels_disc_index import _UdfBuilder, _vmg_ifo
from tests.playback.test_disc_fallback import real_media as real_media  # noqa: F401
from tests.playback.test_disc_fallback import (
    reordered_dvd as reordered_dvd,
)  # noqa: F401
from tests.playback.test_disc_fallback import (
    reordered_dvd_structure,
    tone_frequency,
    vts_ifo,
)

from movieclaw_api.api.routes import playback as playback_route
from movieclaw_api.core.config import get_settings
from movieclaw_api.services.playback import plan as playback_plan
from movieclaw_api.services.playback.session import reset_session_manager
from movieclaw_db.engine import get_database
from movieclaw_db.models import FileSource, FileState, LibraryFile, MediaItem
from movieclaw_db.repositories.library_repo import LibraryRepository

CAPABILITY = {
    "universal": True,
    "disc_image": False,
    "disc_folder": False,
    "video": [],
    "audio": [],
    "containers": ["mp4", "hls-fmp4"],
}


def optical_file(root, media, kind, reordered=None):
    if kind == "dvd-stream-order":
        structure = reordered_dvd_structure(reordered)
    elif kind.startswith("bdmv"):
        structure = {
            "BDMV": {
                "PLAYLIST": {"00001.mpls": _mpls(("00001", 63000, 243000))},
                "STREAM": {"00001.m2ts": media["pgs" if "pgs" in kind else "h264"]},
            }
        }
    else:
        payload = media["mpeg2video"]
        payload = payload.ljust(-(-len(payload) // 2048) * 2048, b"\0")
        structure = {
            "VIDEO_TS": {
                "VIDEO_TS.IFO": _vmg_ifo([1]),
                "VTS_01_0.IFO": vts_ifo([(0, len(payload) // 2048 - 1, 4, 0)]),
                "VTS_01_1.VOB": payload,
            }
        }
    if kind.endswith("iso"):
        path = root / (kind + ".iso")
        path.write_bytes(_UdfBuilder(metadata=True).build(structure))
        return path, "iso"
    path = root / "dvd"
    for folder, entries in structure.items():
        for name, data in entries.items():
            target = path / folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    return path, "dvd"


@pytest.mark.parametrize(
    "kind,audio_index",
    [
        ("bdmv-iso", None),
        ("dvd-iso", None),
        ("dvd-folder", None),
        ("bdmv-pgs-iso", None),
        ("dvd-stream-order", 0),
        ("dvd-stream-order", 1),
    ],
)
@pytest.mark.integration
def test_windows_disc_session_hls_media_resume_and_cleanup(
    client, monkeypatch, tmp_path, real_media, reordered_dvd, kind, audio_index
):
    monkeypatch.setenv("MOVIECLAW_TRANSCODE_DIR", str(tmp_path / "segments"))
    get_settings.cache_clear()
    reset_session_manager()
    from movieclaw_api.services import media_extract

    monkeypatch.setattr(media_extract, "cache_dir", lambda: tmp_path / "subtitles")
    monkeypatch.setattr(playback_plan, "hardware_available", lambda: False)
    monkeypatch.setattr(playback_route, "available_backends", lambda: ())
    monkeypatch.setattr(playback_route.trickplay, "schedule", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(playback_route.skip_segments, "schedule_playback_bump", lambda *_args: None)
    monkeypatch.setattr(playback_route.playback_warmup, "cancel", lambda *_args: None)
    response = client.post(
        "/api/v1/auth/bootstrap", json={"username": "admin", "password": "test-pass-1234"}
    )
    assert response.status_code == 200
    path, container = optical_file(tmp_path, real_media, kind, reordered_dvd)

    async def seed():
        async with get_database().session() as session:
            library = await LibraryRepository(session).create(
                name="Disc", kind="movie", root_paths=[str(tmp_path)]
            )
            item = MediaItem(
                kind="movie",
                title="Synthetic disc",
                original_title="Synthetic disc",
                external_id="999999",
                tmdb_id=999999,
            )
            session.add(item)
            await session.flush()
            file = LibraryFile(
                library_id=library.id,
                media_item_id=item.id,
                file_path=str(path),
                source=FileSource.SCANNED,
                state=FileState.IN_PLACE,
                container=container,
                duration_seconds=99999,
                video_codec=None,
                size_bytes=path.stat().st_size,
            )
            session.add(file)
            await session.commit()
            return file.id

    file_id = client.portal.call(seed)
    body = {"file_id": file_id, "capability": CAPABILITY, "client": "web", "start_ms": 0}
    if audio_index is not None:
        body["audio_track"] = f"embedded:{audio_index}"
    response = client.post("/api/v1/playback/sessions", json=body)
    assert response.status_code == 200, response.text
    first = response.json()["data"]
    assert first["decision"]["outcome"] == "plan"
    assert first["decision"]["tier"] == 1 and first["decision"]["disc"] is None
    assert first["source"]["duration_ms"] == 4000
    assert first["decision"]["audio_tracks"][0]["codec"] == "ac3"
    if audio_index is not None:
        assert first["decision"]["audio"]["track_ref"] == f"embedded:{audio_index}"
        assert first["source"]["subtitle_codecs"] == ["dvd_subtitle"]
        assert first["decision"]["subtitles"] == []
    if "pgs" in kind:
        assert first["decision"]["subtitles"][0]["kind"] == "pgs"
        subtitle = client.get(first["subtitle_urls"][0])
        assert subtitle.status_code == 200 and subtitle.content.startswith(b"PG")
    playlist = client.get(first["stream_url"])
    assert playlist.status_code == 200 and "#EXTINF" in playlist.text
    for line in playlist.text.splitlines():
        if line and not line.startswith("#"):
            media = client.get(
                line
                if line.startswith("/")
                else str(urlsplit(first["stream_url"]).path).rsplit("/", 1)[0] + "/" + line
            )
            assert media.status_code == 200 and len(media.content) > 188
            break
    if audio_index is not None:
        samples = download_audio_samples(client, first["stream_url"], tmp_path / "first-media")
        assert tone_frequency(samples, 0.5, 1.5) == pytest.approx(440 * (audio_index + 1), abs=20)
        assert tone_frequency(samples, 2.5, 3.5) == pytest.approx(440 * (audio_index + 1), abs=20)
    second = client.post("/api/v1/playback/sessions", json={**body, "start_ms": 2000})
    assert second.status_code == 200, second.text
    second = second.json()["data"]
    assert second["source"]["duration_ms"] == 4000 and second["start_ms"] == 2000
    assert second["session_id"] != first["session_id"]
    if audio_index is not None:
        assert second["source"]["subtitle_codecs"] == first["source"]["subtitle_codecs"]
        samples = download_audio_samples(client, second["stream_url"], tmp_path / "resume-media")
        assert tone_frequency(samples, 0.4, 1.4) == pytest.approx(440 * (audio_index + 1), abs=20)
    assert client.delete("/api/v1/playback/sessions/" + second["session_id"]).status_code == 200
    assert client.get(second["stream_url"]).status_code == 404
    assert not (tmp_path / "segments" / second["session_id"]).exists()


def download_audio_samples(client, stream_url, destination):
    """Decode only bytes delivered by the real HTTP playlist/segment routes."""
    import struct
    import subprocess

    destination.mkdir()
    response = client.get(stream_url)
    assert response.status_code == 200, response.text
    lines = []
    base = urlsplit(stream_url).path.rsplit("/", 1)[0]
    for index, line in enumerate(response.text.splitlines()):
        if not line or line.startswith("#"):
            lines.append(line)
            continue
        response = client.get(line if line.startswith("/") else base + "/" + line)
        assert response.status_code == 200
        filename = f"segment-{index}.ts"
        (destination / filename).write_bytes(response.content)
        lines.append(filename)
    playlist = destination / "index.m3u8"
    playlist.write_text("\n".join(lines) + "\n")
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(playlist),
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
    )
    return struct.unpack("<" + "f" * (len(result.stdout) // 4), result.stdout)
