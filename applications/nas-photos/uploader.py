#!/usr/bin/env python3
"""Select and push one random eligible NAS photo to the NAS Photos Paper."""

import json
import os
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

PROJECT_DIR = Path.home() / "openpaper-photo-service"
INDEX_FILE = PROJECT_DIR / "photo_index.json"
HISTORY_FILE = PROJECT_DIR / "photo_history_upload.json"
HISTORY_LIMIT = 100
UPLOAD_URL = os.environ.get("NAS_PHOTOS_UPLOAD_URL", "").rstrip("/")
UPLOAD_TOKEN = os.environ.get("NAS_PHOTOS_UPLOAD_TOKEN", "")


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def main():
    if not UPLOAD_URL or not UPLOAD_TOKEN:
        fail("Set NAS_PHOTOS_UPLOAD_URL and NAS_PHOTOS_UPLOAD_TOKEN first.")
    if not INDEX_FILE.is_file():
        fail(f"Photo index not found: {INDEX_FILE}")

    photos = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    if not isinstance(photos, list) or not photos:
        fail("Photo index is empty or invalid.")

    try:
        history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        history = []

    available = [photo for photo in photos if photo not in history]
    if not available:
        history = []
        available = photos

    selected = random.choice(available)
    path = Path(selected).expanduser()
    if not path.is_file():
        fail(f"Photo no longer exists: {path}")

    content_type = "image/jpeg"
    request = urllib.request.Request(
        UPLOAD_URL,
        data=path.read_bytes(),
        headers={
            "Authorization": f"Bearer {UPLOAD_TOKEN}",
            "Content-Type": content_type,
            "X-Photo-Message-Id": str(uuid4()),
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            result = json.loads(response.read().decode("utf-8"))
            if response.status not in (200, 202):
                fail(f"Upload returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        fail(f"Upload failed with HTTP {error.code}: {detail}")
    except Exception as error:
        fail(f"Upload failed: {error}")

    history.append(selected)
    HISTORY_FILE.write_text(json.dumps(history[-HISTORY_LIMIT:], indent=2), encoding="utf-8")
    print(f"Uploaded: {path.name}")
    print(f"PaperlessPaper accepted the photo. Request: {result.get('requestId', 'unknown')}")


if __name__ == "__main__":
    main()
