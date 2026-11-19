#!/usr/bin/env python3
"""Maintain a four-photo Cloudflare R2 queue from the local NAS photo library."""

import getpass
import json
import random
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps

PROJECT_DIR = Path.home() / "openpaper-photo-service"
INDEX_FILE = PROJECT_DIR / "photo_index.json"
HISTORY_FILE = PROJECT_DIR / "photo_history_upload.json"
HISTORY_LIMIT = 100
WORKER_URL = "https://nas-photos.m9051089850.workers.dev"
CACHE_STATUS_URL = WORKER_URL + "/api/cache-status"
CACHE_UPLOAD_URL = WORKER_URL + "/api/cache-upload"
KEYCHAIN_SERVICE = "OpenPaper NAS Photos Upload"
MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
CACHE_CAPACITY = 4
MAX_ATTEMPTS_PER_RUN = 10


def log(message):
    timestamp = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    print(f"[{timestamp}] {message}", flush=True)


def fail(message):
    log(f"ERROR: {message}")
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
    log("Upload secret saved in macOS Keychain.")


def load_token():
    result = subprocess.run(
        ["security", "find-generic-password", "-a", account_name(),
         "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True, text=True,
    )
    if result.returncode:
        fail("No upload secret found in macOS Keychain.")
    return result.stdout.strip()


def load_history():
    try:
        value = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except FileNotFoundError:
        return []


def save_history(history):
    HISTORY_FILE.write_text(json.dumps(history[-HISTORY_LIMIT:], indent=2), encoding="utf-8")


def api_json(url, token):
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                 "User-Agent": "OpenPaper-NAS-Photos/0.3"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


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
            raise ValueError("Photo remains larger than 20 MiB after compression.")
        return temp_path.read_bytes(), temp_path


def upload_to_cache(path, token):
    image_bytes, temp_path = prepare_image(path)
    request = urllib.request.Request(
        CACHE_UPLOAD_URL,
        data=image_bytes,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "image/jpeg",
            "User-Agent": "OpenPaper-NAS-Photos/0.3",
            "Accept": "application/json",
            "X-Photo-Filename": path.name,
            "X-Photo-Message-Id": str(uuid4()),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        if error.code == 409:
            return {"full": True}
        raise RuntimeError(f"Cache upload failed with HTTP {error.code}: {detail}") from error
    except Exception as error:
        raise RuntimeError(f"Cache upload failed: {error}") from error
    finally:
        if temp_path:
            temp_path.unlink(missing_ok=True)


def main():
    if "--save-token" in sys.argv:
        save_token()
        return

    automatic = "--automatic" in sys.argv
    if automatic:
        log("Automatic cache replenishment started.")

    if not INDEX_FILE.is_file():
        fail(f"Photo index not found: {INDEX_FILE}")
    photos = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    if not isinstance(photos, list) or not photos:
        fail("Photo index is empty or invalid.")

    token = load_token()
    status = api_json(CACHE_STATUS_URL, token)
    queued = status.get("count", 0)
    if queued >= CACHE_CAPACITY:
        log(f"Cache already full: {queued}/{CACHE_CAPACITY} photos. Nothing to do.")
        return

    history = load_history()
    attempted = set()
    errors = []
    added = 0

    while queued < CACHE_CAPACITY and len(attempted) < MAX_ATTEMPTS_PER_RUN:
        candidates = [photo for photo in photos if photo not in history and photo not in attempted]
        if not candidates:
            candidates = [photo for photo in photos if photo not in attempted]
        if not candidates:
            break
        random.shuffle(candidates)

        selected = None
        for candidate in candidates:
            candidate_path = Path(candidate).expanduser()
            if candidate_path.is_file():
                selected = candidate_path
                break
            attempted.add(candidate)
            errors.append(f"{candidate}: file missing or inaccessible")
            log(f"WARNING: Skipping unavailable photo: {candidate}")

        if selected is None:
            break

        attempted.add(str(selected))
        try:
            result = upload_to_cache(selected, token)
        except Exception as error:
            errors.append(f"{selected.name}: {error}")
            log(f"WARNING: Could not upload {selected.name}: {error}")
            # Check whether the server accepted an upload before the connection failed.
            try:
                status = api_json(CACHE_STATUS_URL, token)
                queued = status.get("count", queued)
            except Exception as status_error:
                log(f"WARNING: Could not refresh cache status: {status_error}")
            continue

        if result.get("full"):
            log("Cloudflare cache became full during upload. Stopping.")
            queued = CACHE_CAPACITY
            break

        history.append(str(selected))
        save_history(history)
        queued = result.get("count", queued + 1)
        added += 1
        log(f"Cached: {selected.name} ({queued}/{CACHE_CAPACITY})")

    if errors:
        log(f"Finished with {len(errors)} issue(s).")
    log(f"Cache replenishment complete. Added {added} photo(s); {queued}/{CACHE_CAPACITY} waiting.")
    if queued < CACHE_CAPACITY and errors:
        log("Some photos could not be used. The next scheduled run will try again.")


if __name__ == "__main__":
    main()
