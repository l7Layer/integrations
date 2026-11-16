#!/usr/bin/env python3
"""Push one random eligible NAS photo to the connected OpenPaper Paper."""

import getpass
import json
import random
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, time, timedelta
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps

PROJECT_DIR = Path.home() / "openpaper-photo-service"
INDEX_FILE = PROJECT_DIR / "photo_index.json"
HISTORY_FILE = PROJECT_DIR / "photo_history_upload.json"
LAST_UPLOAD_FILE = PROJECT_DIR / "photo_last_upload.json"
HISTORY_LIMIT = 100
UPLOAD_URL = "https://nas-photos.m9051089850.workers.dev/api/upload"
KEYCHAIN_SERVICE = "OpenPaper NAS Photos Upload"
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def account_name():
    return getpass.getuser()


def save_token():
    token = getpass.getpass("Paste the NAS Photos upload secret (input hidden): ").strip()
    if len(token) != 64:
        fail("The upload secret should contain 64 hexadecimal characters.")
    try:
        int(token, 16)
    except ValueError:
        fail("The upload secret must be hexadecimal.")
    result = subprocess.run(
        ["security", "add-generic-password", "-U", "-a", account_name(),
         "-s", KEYCHAIN_SERVICE, "-w", token],
        capture_output=True, text=True,
    )
    if result.returncode:
        fail(result.stderr.strip() or "Could not save the secret to macOS Keychain.")
    print("Upload secret saved in macOS Keychain.")


def load_token():
    result = subprocess.run(
        ["security", "find-generic-password", "-a", account_name(),
         "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True, text=True,
    )
    if result.returncode:
        fail("No upload secret found. Run: python uploader.py --save-token")
    return result.stdout.strip()


def load_history():
    try:
        value = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except FileNotFoundError:
        return []


def last_successful_upload():
    try:
        value = json.loads(LAST_UPLOAD_FILE.read_text(encoding="utf-8"))
        return datetime.fromisoformat(value["uploadedAt"])
    except (FileNotFoundError, KeyError, ValueError, TypeError, json.JSONDecodeError):
        # Migrate safely: the history file is written only after a successful upload.
        try:
            return datetime.fromtimestamp(HISTORY_FILE.stat().st_mtime)
        except FileNotFoundError:
            return None


def automatic_upload_is_due():
    now = datetime.now()
    today_at_six = datetime.combine(now.date(), time(18, 0))
    latest_scheduled_run = today_at_six if now >= today_at_six else today_at_six - timedelta(days=1)
    last_upload = last_successful_upload()
    return last_upload is None or last_upload < latest_scheduled_run


def prepare_image(path):
    data = path.read_bytes()
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        if image.width * image.height <= MAX_PIXELS and len(data) <= MAX_BYTES:
            return data, None

        image.thumbnail((int(MAX_PIXELS ** 0.5), int(MAX_PIXELS ** 0.5)))
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")

        temp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        temp_path = Path(temp.name)
        temp.close()
        image.save(temp_path, format="JPEG", quality=88, optimize=True)
        if temp_path.stat().st_size > MAX_BYTES:
            image.save(temp_path, format="JPEG", quality=75, optimize=True)
        if temp_path.stat().st_size > MAX_BYTES:
            temp_path.unlink(missing_ok=True)
            fail("The selected photo is still larger than 20 MiB after compression.")
        return temp_path.read_bytes(), temp_path


def main():
    if "--save-token" in sys.argv:
        save_token()
        return

    automatic = "--automatic" in sys.argv
    if automatic and not automatic_upload_is_due():
        print("No upload needed. Today's 18:00 upload has already been completed.")
        return

    if not INDEX_FILE.is_file():
        fail(f"Photo index not found: {INDEX_FILE}")
    photos = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    if not isinstance(photos, list) or not photos:
        fail("Photo index is empty or invalid.")

    history = load_history()
    available = [photo for photo in photos if photo not in history]
    if not available:
        history = []
        available = photos

    random.shuffle(available)
    selected = next((Path(p).expanduser() for p in available if Path(p).expanduser().is_file()), None)
    if selected is None:
        fail("No existing photo was found in the index.")

    token = load_token()
    temp_path = None
    try:
        image_bytes, temp_path = prepare_image(selected)
    except Exception as error:
        fail(f"Could not prepare photo {selected.name}: {error}")

    request = urllib.request.Request(
        UPLOAD_URL,
        data=image_bytes,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "image/jpeg",
            "User-Agent": "OpenPaper-NAS-Photos/0.1",
            "Accept": "application/json",
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
    finally:
        if temp_path:
            temp_path.unlink(missing_ok=True)

    history.append(str(selected))
    HISTORY_FILE.write_text(json.dumps(history[-HISTORY_LIMIT:], indent=2), encoding="utf-8")
    uploaded_at = datetime.now().astimezone().isoformat(timespec="seconds")
    LAST_UPLOAD_FILE.write_text(
        json.dumps({"uploadedAt": uploaded_at}, indent=2), encoding="utf-8"
    )
    print(f"Uploaded: {selected.name}")
    print(f"PaperlessPaper accepted the photo. Request: {result.get('requestId', 'unknown')}")
    print("The frame will update according to its normal sync schedule.")


if __name__ == "__main__":
    main()
