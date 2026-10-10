"""Stable releases require the exact tested artifacts and physical acceptance evidence."""

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys

REQUIRED_CHECKS = (
    "embedded_render",
    "first_frame_seek",
    "hardware_decode",
    "hdr_sdr",
    "audio_passthrough",
    "dpi_multimonitor",
    "power_media_keys",
    "window_restore",
    "resume_twenty_cycles",
    "windows_macos_performance",
)


def validate(directory, evidence, revision, version):
    if evidence.get("schema_version") != 1 or evidence.get("scope") != "physical-windows-and-macos":
        raise ValueError(
            "Physical Windows/macOS acceptance is missing; hosted VM smoke is insufficient"
        )
    if evidence.get("revision") != revision or evidence.get("version") != version:
        raise ValueError("Physical evidence must match the exact release revision and version")
    for platform, required in (
        ("windows", ("machine_id", "os", "gpu", "driver")),
        ("macos", ("machine_id", "model", "os")),
    ):
        machine = evidence.get(platform, {})
        if not all(isinstance(machine.get(key), str) and machine[key].strip() for key in required):
            raise ValueError(f"Missing {platform} physical-machine identity")
    for name in REQUIRED_CHECKS:
        check = evidence.get("checks", {}).get(name, {})
        if (
            check.get("status") != "passed"
            or not isinstance(check.get("evidence_url"), str)
            or not check["evidence_url"].startswith("https://")
        ):
            raise ValueError(f"Physical acceptance has not passed: {name}")
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8-sig"))
    if manifest.get("sourceRevision") != revision or manifest.get("version") != version:
        raise ValueError("The reused CI artifact does not match this release source")
    for name in ("installer", "application"):
        signature = manifest.get("signatures", {}).get(name, {})
        if signature.get("status") != "Valid" or not signature.get("thumbprint"):
            raise ValueError(f"Stable {name} requires a real valid Authenticode signature")
    expected_names = {
        f"MovieClaw-Desktop-{version}-Setup-x64.exe",
        f"MovieClaw-Desktop-{version}-portable-x64.zip",
    }
    files = manifest.get("files", [])
    if {item.get("name") for item in files} != expected_names or len(files) != 2:
        raise ValueError("Release manifest must contain precisely both Windows x64 packages")
    for item in files:
        name = item["name"]
        path = directory / name
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != item.get("sha256") or path.stat().st_size != item.get("size"):
            raise ValueError(f"Release artifact changed: {name}")
        if evidence.get("artifact_sha256", {}).get(name) != digest:
            raise ValueError(f"Physical testing did not use this exact artifact: {name}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=pathlib.Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--evidence", type=pathlib.Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise ValueError("A full release commit SHA is required")
    raw = (
        args.evidence.read_text()
        if args.evidence
        else os.environ.get("DESKTOP_HARDWARE_ACCEPTANCE_JSON", "")
    )
    if not raw:
        raise ValueError(
            "No physical acceptance evidence configured; "
            "CI packages remain available without stable publication"
        )
    validate(args.directory, json.loads(raw), args.revision, args.version)
    print(
        "Stable release gate passed: exact artifacts, valid signatures "
        "and physical Windows/macOS evidence"
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print(f"Stable release blocked: {error}", file=sys.stderr)
        sys.exit(1)
