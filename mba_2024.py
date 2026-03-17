from __future__ import annotations

import base64
import csv
import json
import os
import shutil
import sys
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any

import openpyxl
import pandas as pd
import paramiko
import requests
from boxsdk import Client, JWTAuth
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from PIL import Image, ImageDraw, ImageFont
import psycopg2
import boto3


# ----------------------------
# Config (.env)
# ----------------------------


def _load_env_file(env_path: Path) -> None:
    """
    Minimal .env loader (KEY=VALUE). Does not override existing env vars.
    Supports comments (#...), quoted values, and blank lines.
    """
    try:
        if not env_path.exists():
            return
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = val
    except Exception:
        # Config loading should never crash the app; logging may not be ready yet.
        return


@dataclass(frozen=True)
class EnvSettings:
    base_dir: Path  # python/

    def get(self, key: str, default: Any | None = None) -> Any:
        # Keep the existing call sites (`settings.get("Key")`) but source from env.
        return os.getenv(key, default)

    def get_bool(self, key: str, default: bool = False) -> bool:
        v = os.getenv(key)
        if v is None:
            return default
        return str(v).strip().lower() in {"1", "true", "yes", "y", "on"}

    def get_int(self, key: str, default: int) -> int:
        v = os.getenv(key)
        if v is None or str(v).strip() == "":
            return default
        try:
            return int(str(v).strip())
        except Exception:
            return default

    @property
    def test_mode(self) -> bool:
        return self.get_bool("TestMode", False)


def load_settings() -> EnvSettings:
    base_dir = Path(__file__).resolve().parent  # python/
    _load_env_file(base_dir / ".env")
    return EnvSettings(base_dir=base_dir)


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


# ----------------------------
# Logging (Log / LogError) + DB table MBA_Loges (PostgreSQL)
# ----------------------------

# Table: MBA_Loges (id SERIAL PRIMARY KEY, log_type TEXT, error TEXT)


def _get_pg_conn_params(settings: EnvSettings) -> dict[str, Any] | None:
    host = settings.get("DB_HOST")
    name = settings.get("DB_NAME")
    user = settings.get("DB_USER")
    password = settings.get("DB_PASSWORD")
    port = settings.get("DB_PORT")
    if not all((host, name, user, password, port)):
        return None
    return {
        "host": str(host),
        "dbname": str(name),
        "user": str(user),
        "password": str(password),
        "port": int(str(port)),
    }


def _ensure_mba_loges_table(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS "MBA_Loges" (
                id SERIAL PRIMARY KEY,
                log_type TEXT NOT NULL,
                error TEXT NOT NULL
            )
            """
        )
    conn.commit()


def _write_log_to_db(settings: EnvSettings, log_type: str, message: str) -> None:
    try:
        params = _get_pg_conn_params(settings)
        if not params:
            return
        conn = psycopg2.connect(**params)
        try:
            _ensure_mba_loges_table(conn)
            with conn.cursor() as cur:
                cur.execute(
                    'INSERT INTO "MBA_Loges" (log_type, error) VALUES (%s, %s)',
                    (log_type, message),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass  # Don't let DB logging break file/console logging


# ----------------------------
# Cloudflare R2 helpers (S3-compatible object storage)
# ----------------------------


def _get_r2_client_and_bucket(settings: EnvSettings) -> tuple[Any | None, str | None]:
    """
    Returns (client, bucket). Raises RuntimeError if R2 is not configured,
    because R2 is now a required dependency.
    """
    endpoint = settings.get("R2_ENDPOINT")
    access_key = settings.get("R2_ACCESS_KEY_ID")
    secret_key = settings.get("R2_SECRET_ACCESS_KEY")
    bucket = settings.get("R2_BUCKET")
    if not all((endpoint, access_key, secret_key, bucket)):
        raise RuntimeError(
            "Cloudflare R2 is not configured. Please set R2_ENDPOINT, "
            "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET."
        )
    session = boto3.session.Session()
    client = session.client(
        "s3",
        endpoint_url=str(endpoint),
        aws_access_key_id=str(access_key),
        aws_secret_access_key=str(secret_key),
    )
    return client, str(bucket)


def _upload_to_r2(settings: EnvSettings, key: str, data: bytes, content_type: str) -> None:
    """
    Upload to R2; if it fails, log and re-raise so the run clearly fails.
    """
    try:
        client, bucket = _get_r2_client_and_bucket(settings)
        client.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
        # Record a success log entry with the exact key.
        _write_log_to_db(settings, "log", f"R2 upload succeeded: bucket={bucket}, key={key}, content_type={content_type}")
    except Exception as ex:
        # Log to DB and re-raise to surface the problem.
        _write_log_to_db(settings, "log error", f"R2 upload failed for {key}: {ex}")
        raise


def log(message: str) -> None:
    settings = load_settings()
    _write_log_to_db(settings, "log", message)
    try:
        print(message, flush=True)
    except Exception:
        pass


def log_error(message: str) -> None:
    settings = load_settings()
    _write_log_to_db(settings, "log error", message)
    try:
        print(message, file=sys.stderr, flush=True)
    except Exception:
        pass


# ----------------------------
# SFTP
# ----------------------------


def _ensure_remote_dir(sftp: paramiko.SFTPClient, remote_dir: str) -> None:
    parts = [p for p in remote_dir.replace("\\", "/").split("/") if p]
    current = ""
    for p in parts:
        current = f"{current}/{p}" if current else f"/{p}"
        try:
            sftp.stat(current)
        except IOError:
            try:
                sftp.mkdir(current)
            except Exception:
                pass


def download_csvs_and_move_to_processed(
    *,
    host: str,
    port: int,
    username: str,
    password: str,
    order_folder: str,
    processed_folder: str,
    local_folder: Path,
) -> list[Path]:
    downloaded: list[Path] = []
    transport = None
    sftp = None
    try:
        transport = paramiko.Transport((host, port))
        transport.connect(username=username, password=password)
        sftp = paramiko.SFTPClient.from_transport(transport)

        for entry in sftp.listdir_attr(order_folder):
            name = entry.filename
            if not name.lower().endswith(".csv"):
                continue
            remote_path = f"{order_folder.rstrip('/')}/{name}"
            local_path = local_folder / name
            sftp.get(remote_path, str(local_path))
            downloaded.append(local_path)

            remote_processed = f"{processed_folder.rstrip('/')}/{name}"
            try:
                sftp.rename(remote_path, remote_processed)
                log(f"Successfully moved file to processed folder: {remote_processed}")
            except Exception as ex:
                log_error(f"Error moving file to processed folder: {remote_processed}. Error: {ex}")
    finally:
        try:
            if sftp:
                sftp.close()
        except Exception:
            pass
        try:
            if transport:
                transport.close()
        except Exception:
            pass
    return downloaded


def upload_file(
    *,
    local_file_path: Path,
    sftp_directory: str,
    host: str,
    port: int,
    username: str,
    password: str,
) -> None:
    max_retries = 3
    last_error: Exception | None = None

    for attempt in range(1, max_retries + 1):
        transport = None
        sftp = None
        try:
            transport = paramiko.Transport((host, port))
            transport.connect(username=username, password=password)
            sftp = paramiko.SFTPClient.from_transport(transport)

            _ensure_remote_dir(sftp, sftp_directory)
            remote_path = f"{sftp_directory.rstrip('/')}/{local_file_path.name}"
            sftp.put(str(local_file_path), remote_path)
            log_error(
                f"File '{local_file_path.name}' uploaded successfully to SFTP "
                f"(attempt {attempt}/{max_retries})."
            )
            return
        except Exception as ex:
            last_error = ex
            log_error(
                f"Error during SFTP upload of '{local_file_path.name}' "
                f"(attempt {attempt}/{max_retries}): {ex}"
            )
        finally:
            try:
                if sftp:
                    sftp.close()
            except Exception:
                pass
            try:
                if transport:
                    transport.close()
            except Exception:
                pass

    # All retries failed – send a notification email.
    try:
        settings = load_settings()
        subject = f"SFTP upload failed for {local_file_path.name}"
        body = f"""
<html>
<body>
<p>Hi,</p>
<p>The application tried {max_retries} times but could not upload file
<b>{local_file_path.name}</b> to SFTP directory <b>{sftp_directory}</b>.</p>
<p>Last error message:<br/>
{last_error}</p>
<p>Please investigate the SFTP server or network connectivity.</p>
<p>Regards,<br/>
Weblegs Support Team</p>
</body>
</html>
"""
        # Use the standard send_mail helper so only the "no CSV found" case
        # uses the notification-style email.
        send_mail(settings.base_dir, body, str(local_file_path))
    except Exception as ex:
        log_error(f"Failed to send SFTP failure notification email: {ex}")


def _upload_csv_bytes_to_sftp(
    *,
    csv_bytes: bytes,
    remote_name: str,
    sftp_directory: str,
    host: str,
    port: int,
    username: str,
    password: str,
) -> None:
    """
    Upload CSV content (already serialized to bytes) directly to SFTP without
    writing a local file.
    """
    max_retries = 3
    last_error: Exception | None = None

    for attempt in range(1, max_retries + 1):
        transport = None
        sftp = None
        try:
            transport = paramiko.Transport((host, port))
            transport.connect(username=username, password=password)
            sftp = paramiko.SFTPClient.from_transport(transport)

            _ensure_remote_dir(sftp, sftp_directory)
            remote_path = f"{sftp_directory.rstrip('/')}/{remote_name}"
            with BytesIO(csv_bytes) as bio:
                sftp.putfo(bio, remote_path)
            log_error(
                f"CSV '{remote_name}' uploaded successfully to SFTP "
                f"(attempt {attempt}/{max_retries})."
            )
            return
        except Exception as ex:
            last_error = ex
            log_error(
                f"Error during SFTP CSV upload of '{remote_name}' "
                f"(attempt {attempt}/{max_retries}): {ex}"
            )
        finally:
            try:
                if sftp:
                    sftp.close()
            except Exception:
                pass
            try:
                if transport:
                    transport.close()
            except Exception:
                pass

    try:
        settings = load_settings()
        subject = f"SFTP CSV upload failed for {remote_name}"
        body = f"""
<html>
<body>
<p>Hi,</p>
<p>The application tried {max_retries} times but could not upload CSV
<b>{remote_name}</b> to SFTP directory <b>{sftp_directory}</b>.</p>
<p>Last error message:<br/>
{last_error}</p>
<p>Please investigate the SFTP server or network connectivity.</p>
<p>Regards,<br/>
Weblegs Support Team</p>
</body>
</html>
"""
        # Use the standard send_mail helper so only the "no CSV found" case
        # uses the notification-style email.
        send_mail(settings.base_dir, body, "")
    except Exception as ex:
        log_error(f"Failed to send SFTP CSV failure notification email: {ex}")


# ----------------------------
# Excel / CSV helpers
# ----------------------------


@dataclass
class Job:
    """
    Represents a single CSV order file and its in-memory data.

    - csv_path: original CSV downloaded from SFTP
    - raw_df: full CSV data (used later by create_excel_and_upload)
    - work_df: processed rows (Bilcode, Gender, Type, Color, Size, plus Box columns)
    """

    csv_path: Path
    raw_df: pd.DataFrame
    work_df: pd.DataFrame


def build_jobs_from_csvs(csv_paths: list[Path], is_test_mode: bool) -> list[Job]:
    """
    Read each CSV into memory and build a minimal worksheet-like DataFrame
    with columns [Bilcode, Gender, Type, Color, Size], mimicking the old
    process_excel_file logic, but without creating intermediate Excel files.
    """
    jobs: list[Job] = []
    for csv_file_path in csv_paths:
        try:
            raw_df = pd.read_csv(csv_file_path, dtype=str).fillna("")
        except Exception as ex:
            log_error(f"Error reading CSV '{csv_file_path}': {ex}")
            continue

        if raw_df.shape[0] == 0:
            log_error(f"CSV '{csv_file_path}' is empty.")
            continue

        rows: list[list[str]] = []
        rows_to_process = min(20, raw_df.shape[0]) if is_test_mode else raw_df.shape[0]
        for idx in range(rows_to_process):
            try:
                inv = raw_df.iloc[idx, 0]
            except Exception:
                inv = ""
            inv = "" if inv is None else str(inv).strip()
            if not inv:
                continue
            parts = inv.split("-")
            if len(parts) == 5:
                rows.append([p.strip() for p in parts[:5]])
            else:
                log_error(f"File format mismatch detected for inventory value: {inv}")

        if not rows:
            log_error(f"No valid rows found in CSV '{csv_file_path}'.")
            continue

        work_df = pd.DataFrame(rows, columns=["Bilcode", "Gender", "Type", "Color", "Size"])
        jobs.append(Job(csv_path=csv_file_path, raw_df=raw_df, work_df=work_df))

    return jobs


def read_sheet_to_dataframe(xlsx_path: Path, sheet_name: str) -> pd.DataFrame:
    return pd.read_excel(xlsx_path, sheet_name=sheet_name, dtype=str).fillna("")


def write_dataframe_to_excel(df: pd.DataFrame, xlsx_path: Path, sheet_name: str) -> None:
    xlsx_path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name=sheet_name, index=False)


def save_dataframe_to_csv(file_path: Path, df: pd.DataFrame) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with file_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(list(df.columns))
        for _, row in df.iterrows():
            writer.writerow([str(v).replace(",", " ") for v in row.tolist()])


def dataframe_to_csv_bytes(df: pd.DataFrame) -> bytes:
    """
    Serialize DataFrame to CSV bytes using the same formatting as
    save_dataframe_to_csv (replace commas in values with a space).
    """
    s = StringIO()
    writer = csv.writer(s)
    writer.writerow(list(df.columns))
    for _, row in df.iterrows():
        writer.writerow([str(v).replace(",", " ") for v in row.tolist()])
    return s.getvalue().encode("utf-8")


# ----------------------------
# Box (JWT) image search + shared link
# ----------------------------


@dataclass
class BoxSearchResult:
    url: str
    extension: str
    is_pocket: bool
    no_image_found: bool


def _closest_color_match(names: list[str], target_color: str) -> int | None:
    if not names or not target_color:
        return None
    target = target_color.lower().strip()

    def split_words(s: str) -> set[str]:
        import re

        return set([w for w in re.split(r"[-_\s\.]+", s.lower()) if w])

    for i, n in enumerate(names):
        if target in split_words(n):
            return i

    for i, n in enumerate(names):
        lower = n.lower()
        idx = lower.find(target)
        if idx < 0:
            continue
        before = lower[idx - 1] if idx > 0 else " "
        after = lower[idx + len(target)] if idx + len(target) < len(lower) else " "
        if not before.isalnum() and not after.isalnum():
            return i

    for i, n in enumerate(names):
        if target in n.lower():
            return i
    return None


def box_image_functionality(
    *,
    search_term: str,
    color: str,
    credentials_json_path: Path,
    user_id: str,
) -> BoxSearchResult:
    try:
        if not credentials_json_path.exists():
            return BoxSearchResult(url="", extension="", is_pocket=False, no_image_found=True)

        auth = JWTAuth.from_settings_file(str(credentials_json_path))
        base_client = Client(auth)
        # boxsdk `as_user` differs by version: some expect a User object (with `.object_id`),
        # others accept a user id. Support both.
        if user_id and str(user_id).strip() and str(user_id).strip().lower() != "me":
            try:
                client = base_client.as_user(base_client.user(user_id))
            except Exception:
                client = base_client.as_user(user_id)
        else:
            client = base_client

        results = list(
            client.search().query(
                query=search_term,
                file_extensions=["png", "ai", "tif", "psd"],
                limit=500,
            )
        )
        if not results:
            return BoxSearchResult(url="", extension="", is_pocket=False, no_image_found=True)

        def _item_name(x: Any) -> str:
            return str(getattr(x, "name", "") or getattr(x, "object_name", "") or "")

        filtered = [r for r in results if ("dtg" in _item_name(r).lower() or "print" in _item_name(r).lower())]
        if not filtered:
            return BoxSearchResult(url="", extension="", is_pocket=False, no_image_found=True)

        pngs = [r for r in filtered if _item_name(r).lower().endswith(".png")]
        others = [
            r
            for r in filtered
            if _item_name(r).lower().endswith((".tif", ".tiff", ".psd", ".ai"))
        ]
        images = pngs if pngs else others
        if not images:
            return BoxSearchResult(url="", extension="", is_pocket=False, no_image_found=True)

        chosen = None
        if color:
            for r in images:
                if color.lower() in _item_name(r).lower():
                    chosen = r
                    break
            if chosen is None:
                idx = _closest_color_match([_item_name(r) for r in images], color)
                if idx is not None:
                    chosen = images[idx]
        if chosen is None:
            chosen = images[0]

        chosen_name = _item_name(chosen)
        lower_name = chosen_name.lower()
        pocket_keywords = [
            "legging",
            "mug",
            "phone",
            "laptop",
            "nightdress",
            "pyjama",
            "pj",
            "pocket",
            "short set",
            "bottle",
            "cap ",
            "tote",
        ]
        is_pocket = any(k in lower_name for k in pocket_keywords)

        chosen_id = getattr(chosen, "id", None) or getattr(chosen, "object_id", None)
        if not chosen_id:
            raise RuntimeError(f"Box search item missing id: {chosen!r}")

        # `client.file()` signature varies; support both keyword and positional forms.
        try:
            file_obj = client.file(file_id=chosen_id)
        except TypeError:
            file_obj = client.file(chosen_id)

        f = file_obj.update_info(
            data={
                "shared_link": {
                    "access": "open",
                    "permissions": {"can_download": True},
                    "password": None,
                }
            }
        )
        shared = getattr(f, "shared_link", None) or {}
        download_url = shared.get("download_url") or ""
        extension = Path(chosen_name).suffix.lstrip(".")
        return BoxSearchResult(url=download_url, extension=extension, is_pocket=is_pocket, no_image_found=False)
    except Exception as ex:
        try:
            (load_settings().base_dir / "Boxlog.txt").open("a", encoding="utf-8").write(f"Box issues   {ex}\n")
        except Exception:
            pass
        log_error(f"Box error: {ex}")
        return BoxSearchResult(url="", extension="", is_pocket=False, no_image_found=True)


# ----------------------------
# Image helpers
# ----------------------------


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if chunk:
                    f.write(chunk)


def convert_to_png_inplace(folder: Path) -> None:
    for file_path in folder.glob("*"):
        try:
            ext = file_path.suffix.lower()
            if ext in {".psd", ".tiff", ".tif", ".ai"}:
                out = file_path.with_suffix(".png")
                with Image.open(file_path) as im:
                    im = im.convert("RGBA")
                    out.parent.mkdir(parents=True, exist_ok=True)
                    im.save(out, format="PNG")
                file_path.unlink(missing_ok=True)
        except Exception as ex:
            log_error(f"Error processing file '{file_path}': {ex}")


def _has_transparency(im: Image.Image) -> bool:
    if im.mode != "RGBA":
        return False
    alpha = im.getchannel("A")
    return alpha.getextrema()[0] < 255


def _remove_background_simple(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    data = im.getdata()
    new = []
    for r, g, b, a in data:
        if a == 0:
            new.append((r, g, b, 0))
        elif r >= 245 and g >= 245 and b >= 245:
            new.append((r, g, b, 0))
        elif r >= 235 and g >= 235 and b >= 235:
            new.append((r, g, b, 0))
        else:
            new.append((r, g, b, a))
    out = Image.new("RGBA", im.size)
    out.putdata(new)
    return out


def ensure_transparent_backgrounds(folder: Path) -> None:
    if not folder.exists():
        log(f"Directory not found: {folder}")
        return
    for file_path in folder.glob("*.png"):
        try:
            with Image.open(file_path) as im:
                im = im.convert("RGBA")
                if _has_transparency(im):
                    continue
                log(f"Removing background from: {file_path.name}")
                im2 = _remove_background_simple(im)
                im2.save(file_path, format="PNG")
                log(f"Background removed successfully: {file_path.name}")
        except Exception as ex:
            log_error(f"Error processing image '{file_path}': {ex}")


def crop_to_content(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    alpha = im.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return im
    return im.crop(bbox)


def place_on_canvas(im: Image.Image, canvas_width: int, canvas_height: int, margin: int = 30) -> Image.Image:
    """
    Port of the C# centering / sizing logic:
    - Uses top and side margins.
    - Computes available width/height based on image orientation.
    - Ensures a minimum side margin for very tall images.
    """
    im = im.convert("RGBA")
    cw, ch = canvas_width, canvas_height
    w, h = im.size

    # Start with requested margin, then adjust like the C# logic.
    side_margin = float(margin)
    top_margin = float(margin)

    if w > h:
        # Landscape-ish: width-driving case
        aspect = h / w  # height/width
        max_w = cw - 2 * side_margin
        max_h = max_w * aspect
        top_margin = min(top_margin, (ch - max_h) / 2.0)
        side_margin = max(side_margin, (cw - max_w) / 2.0)
    else:
        # Portrait-ish: height-driving case
        aspect = w / h  # width/height
        max_h = ch - 2 * top_margin
        max_w = max_h * aspect

        top_margin = min(top_margin, (ch - max_h) / 2.0)
        side_margin = max(side_margin, (cw - max_w) / 2.0)

        # If horizontal margin would be too small, enforce a larger side margin
        horiz_margin = (cw - max_w) / 2.0
        if horiz_margin < 0 or horiz_margin < 300:
            side_margin = 300.0
            max_w = cw - 2 * side_margin
            max_h = max_w / aspect
            top_margin = min(top_margin, (ch - max_h) / 2.0)
            side_margin = max(side_margin, (cw - max_w) / 2.0)

    # Final target size, clamped
    new_w = max(1, int(round(max_w)))
    new_h = max(1, int(round(max_h)))
    resized = im.resize((new_w, new_h), resample=Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    # Center horizontally within available width, align vertically with top_margin.
    avail_w = cw - 2 * side_margin
    x = int(round(side_margin + (avail_w - new_w) / 2.0))
    y = int(round(top_margin))
    canvas.alpha_composite(resized, (x, y))
    return canvas


def find_y_after_last_nontransparent(im: Image.Image) -> int:
    im = im.convert("RGBA")
    alpha = im.getchannel("A")
    w, h = alpha.size
    pix = alpha.load()
    for y in range(h - 1, -1, -1):
        for x in range(0, w):
            if pix[x, y] != 0:
                return y + 1
    return 0


def draw_license_text_centered(im: Image.Image, text: str) -> Image.Image:
    if not text:
        return im
    im = im.convert("RGBA")
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("arial.ttf", 10)
    except Exception:
        font = ImageFont.load_default()

    sample = im.getpixel((min(100, im.width - 1), min(100, im.height - 1)))
    brightness = (0.299 * sample[0] + 0.587 * sample[1] + 0.114 * sample[2]) / 255.0
    color = (167, 168, 169, 255) if brightness < 0.5 else (0, 0, 0, 255)

    y = find_y_after_last_nontransparent(im)
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    x = (im.width - text_w) // 2
    draw.text((x, y), text, fill=color, font=font)
    return im


def compress_png_under_size(path: Path, target_bytes: int = 25 * 1024 * 1024) -> None:
    try:
        if path.stat().st_size <= target_bytes:
            return
        with Image.open(path) as im:
            im = im.convert("RGBA")
            for level in (9, 6, 3):
                tmp = path.with_suffix(".tmp.png")
                im.save(tmp, format="PNG", optimize=True, compress_level=level)
                if tmp.stat().st_size <= target_bytes or level == 3:
                    tmp.replace(path)
                    return
    except Exception as ex:
        log_error(f"Failed to compress PNG '{path}': {ex}")


# ----------------------------
# Gmail (SendMail / SendNotificationEmail)
# ----------------------------


SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


def _load_client_secrets(cred_path: Path) -> tuple[str, str]:
    data = json.loads(cred_path.read_text(encoding="utf-8"))
    cfg = data.get("installed") or data.get("web") or {}
    client_id = cfg.get("client_id")
    client_secret = cfg.get("client_secret")
    if not client_id or not client_secret:
        raise RuntimeError(f"client_id/client_secret missing in credentials file: {cred_path}")
    return str(client_id), str(client_secret)


def _creds_from_csharp_token(cred_path: Path, token_path: Path) -> Credentials:
    """
    Build Python Credentials from the C# TokenResponse file used by the .NET app.
    Does NOT write or refresh the token, just uses existing access/refresh tokens.
    """
    if not token_path.exists():
        raise FileNotFoundError(f"Gmail token file not found at: {token_path}")
    token_data = json.loads(token_path.read_text(encoding="utf-8"))
    client_id, client_secret = _load_client_secrets(cred_path)

    info = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": token_data.get("refresh_token"),
        "token": token_data.get("access_token"),
        "token_uri": "https://oauth2.googleapis.com/token",
        "scopes": [token_data.get("scope") or SCOPES[0]],
        "type": "authorized_user",
    }
    creds = Credentials.from_authorized_user_info(info, SCOPES)
    # Try to refresh once so the access token is valid, but don't write anything back.
    try:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
    except Exception as ex:
        log_error(f"Gmail token refresh failed for {token_path}: {ex}")
    return creds


def initialize_gmail_service(base_dir: Path):
    settings = load_settings()
    cred_override = settings.get("GMAIL_CREDENTIALS_JSON")
    cred_path = Path(str(cred_override)) if cred_override else (base_dir / "credentials.json")
    if not cred_path.exists():
        raise FileNotFoundError(
            f"Gmail credentials file not found at: {cred_path}. Please add credentials.json file for email functionality."
        )
    token_override = settings.get("GMAIL_TOKEN_PATH")
    if token_override:
        # Use the existing C# token file without creating a new token.json.
        token_path = Path(str(token_override))
        creds = _creds_from_csharp_token(cred_path, token_path)
    else:
        # Standard Python flow using token.json next to the script.
        token_path = base_dir / "token.json"
        token_path.parent.mkdir(parents=True, exist_ok=True)

        creds: Credentials | None = None
        if token_path.exists():
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(str(cred_path), SCOPES)
                creds = flow.run_local_server(port=0)
            try:
                token_path.write_text(creds.to_json(), encoding="utf-8")
            except Exception as ex:
                log_error(f"Failed to write Gmail token file at {token_path}: {ex}")

    return build("gmail", "v1", credentials=creds)


def _create_email_raw(to: str, from_: str, subject: str, body_html: str, attachment: Path | None) -> dict:
    msg = MIMEMultipart()
    msg["To"] = to
    msg["From"] = from_
    msg["Subject"] = subject
    msg.attach(MIMEText(body_html, "html", "utf-8"))

    if attachment and str(attachment) and attachment.exists():
        part = MIMEApplication(attachment.read_bytes(), Name=attachment.name)
        part["Content-Disposition"] = f'attachment; filename="{attachment.name}"'
        msg.attach(part)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    return {"raw": raw}


def _send_message(service, user_id: str, message: dict) -> None:
    service.users().messages().send(userId=user_id, body=message).execute()


def send_mail(base_dir: Path, body_html: str, attachment_file_path: str) -> bool:
    try:
        service = initialize_gmail_service(base_dir)
        subject = "Missing Billcode Images from Box --"
        from_ = "support@weblegs.co.uk"
        recipients = [
           # "support@weblegs.co.uk",
            "ramandeep.matrid33789@gmail.com",
            #"ester.Gomez@brandsin.co.uk",
            #"jaimie.lowe@brandsin.co.uk",
        ]
        attachment = Path(attachment_file_path) if attachment_file_path else None
        for to in recipients:
            msg = _create_email_raw(to=to, from_=from_, subject=subject, body_html=body_html, attachment=attachment)
            _send_message(service, "me", msg)
        return True
    except FileNotFoundError as ex:
        log_error(f"Email sending failed: {ex}")
        return False
    except Exception as ex:
        log_error(f"Email send error: {ex}")
        return False


def send_notification_email(base_dir: Path, attachment_file_path: str | None, body_html: str, subject: str) -> bool:
    try:
        service = initialize_gmail_service(base_dir)
        from_ = "support@weblegs.co.uk"
        recipients = [
           # "support@weblegs.co.uk",
            "ramandeep.matrid33789@gmail.com",
            #"ester.Gomez@brandsin.co.uk",
            #"jaimie.lowe@brandsin.co.uk",
        ]
        attachment = Path(attachment_file_path) if attachment_file_path else None
        for to in recipients:
            msg = _create_email_raw(to=to, from_=from_, subject=subject, body_html=body_html, attachment=attachment)
            _send_message(service, "me", msg)
        return True
    except FileNotFoundError as ex:
        log_error(f"Email sending failed: {ex}")
        return False
    except Exception as ex:
        log_error(f"Notification email send error: {ex}")
        return False


# ----------------------------
# App Orchestration (same 6-step flow)
# ----------------------------


_settings_for_constants = load_settings()
SFTP_HOST = str(_settings_for_constants.get("SFTP_HOST", "ftp.pertembaglobal.com"))
SFTP_PORT = _settings_for_constants.get_int("SFTP_PORT", 22)
SFTP_USERNAME = str(_settings_for_constants.get("SFTP_USERNAME", ""))
SFTP_PASSWORD = str(_settings_for_constants.get("SFTP_PASSWORD", ""))
SFTP_ORDER_FOLDER = str(_settings_for_constants.get("SFTP_ORDER_FOLDER", "/orders/"))
SFTP_PROCESSED_FOLDER = str(_settings_for_constants.get("SFTP_PROCESSED_FOLDER", "/orders/processed/"))
SFTP_DIRECTORY_CSV = str(_settings_for_constants.get("SFTP_DIRECTORY_CSV", "/uploads/CSV"))
SFTP_DIRECTORY_IMAGES = str(_settings_for_constants.get("SFTP_DIRECTORY_IMAGES", "/uploads/img"))


def _process_configured_directories(settings: EnvSettings) -> None:
    keys = [
        "FinalPath",
        "OutputFilePath",
    ]
    dirs = []
    for k in keys:
        v = settings.get(k)
        if v:
            dirs.append(Path(str(v)))
    backup_dir = Path(str(settings.get("backupImagesDirectory", ""))) if settings.get("backupImagesDirectory") else None
    if backup_dir:
        backup_dir.mkdir(parents=True, exist_ok=True)

    for d in dirs:
        if not d.exists():
            continue
        for file in d.glob("*"):
            try:
                ext = file.suffix.lower()
                if ext in {".csv", ".xls", ".xlsx"}:
                    file.unlink(missing_ok=True)
                elif ext in {".jpg", ".jpeg", ".png", ".psd", ".ai"} and backup_dir:
                    dest = backup_dir / file.name
                    if dest.exists():
                        dest = backup_dir / f"{file.stem}_{file.stat().st_mtime_ns}{file.suffix}"
                    shutil.move(str(file), str(dest))
            except Exception:
                pass


def _cleanup_working_directories(settings: EnvSettings) -> None:
    """
    Remove intermediate working folders and files after a successful run.
    This keeps only logs, credentials, and any other non-working artifacts.
    """
    keys = [
        "FinalPath",
        "outputFilePath",
    ]
    for k in keys:
        raw = settings.get(k)
        if not raw:
            continue
        p = Path(str(raw))
        try:
            if p.is_file():
                p.unlink(missing_ok=True)
            elif p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
        except Exception as ex:
            log_error(f"Error cleaning working path '{p}': {ex}")


def get_image_link_for_jobs(settings: EnvSettings, jobs: list[Job]) -> None:
    """
    In-memory version of get_image_link: enrich each Job.work_df with Box image
    information and optionally write a CREATE sheet to ReportOutputPath for
    downstream compatibility.
    """
    report_output_path = Path(str(settings.get("ReportOutputPath", "")))
    report_output_path.mkdir(parents=True, exist_ok=True)

    credentials_env = str(settings.get("BOX_CREDENTIALS_JSON", "")).strip()
    if credentials_env:
        credentials_path = Path(credentials_env)
    else:
        # Prefer the same net472 credentials location (like C# base dir).
        credentials_path = settings.base_dir.parent / "bin" / "Debug" / "net472" / "Credentials" / "899682_cpzawshm_config.json"
        if not credentials_path.exists():
            credentials_path = settings.base_dir / "Credentials" / "899682_cpzawshm_config.json"

    for job in jobs:
        df = job.work_df
        for col in ["ai file", "png file", "psd file", "tif file", "Image Link", "Pocket Print", "No Image Found"]:
            if col not in df.columns:
                df[col] = ""

        for idx, row in df.iterrows():
            bilcode = str(row.get("Bilcode", "")).strip()
            color = str(row.get("Color", "")).strip()
            if not bilcode:
                continue
            res = box_image_functionality(
                search_term=bilcode,
                color=color,
                credentials_json_path=credentials_path,
                user_id=str(settings.get("BOX_USER_ID", "me")),
            )
            if res.url:
                ext = res.extension.lower()
                if ext == "png":
                    df.at[idx, "png file"] = "Yes"
                if ext == "psd":
                    df.at[idx, "psd file"] = "Yes"
                if ext == "ai":
                    df.at[idx, "ai file"] = "Yes"
                if ext in {"tif", "tiff"}:
                    df.at[idx, "tif file"] = "Yes"
                if res.is_pocket:
                    df.at[idx, "Pocket Print"] = res.url
                else:
                    df.at[idx, "Image Link"] = res.url
            if res.no_image_found:
                df.at[idx, "No Image Found"] = res.url or "No Image Found"

        # For compatibility with downstream Excel-based steps, write a CREATE sheet.
        out_path = report_output_path / (job.csv_path.stem + ".xlsx")
        write_dataframe_to_excel(df, out_path, "CREATE")

def download_images_for_jobs(settings: EnvSettings, jobs: list[Job]) -> None:
    """
    In-memory version of download_images: use each Job.work_df to download
    images into ReadyToProcess, and write CREATE sheets to ProcessedFilePath
    for downstream compatibility.
    """
    final_dir = Path(str(settings.get("FinalPath", "")))
    final_dir.mkdir(parents=True, exist_ok=True)

    for job in jobs:
        fil = str(job.csv_path)
        df = job.work_df
        for _, row in df.iterrows():
            url = str(row.get("Image Link", "")).strip()
            if not url:
                continue
            bil = str(row.get("Bilcode", "")).strip()
            gender = str(row.get("Gender", "")).strip()
            typ = str(row.get("Type", "")).strip()
            color = str(row.get("color", row.get("Color", ""))).strip()
            size = str(row.get("size", row.get("Size", ""))).strip()
            try:
                # Download image into memory
                with requests.get(url, stream=True, timeout=60) as r:
                    r.raise_for_status()
                    content = b"".join(chunk for chunk in r.iter_content(chunk_size=1024 * 256) if chunk)

                # Open and normalize to RGBA
                with Image.open(BytesIO(content)) as im:
                    im = im.convert("RGBA")
                    # Simple background removal similar to ensure_transparent_backgrounds
                    if not _has_transparency(im):
                        im = _remove_background_simple(im)
                    # Crop to content
                    cropped = crop_to_content(im)

                # Decide canvas size based on existing rules
                size_u = size.upper()
                typ_u = typ.upper()
                gender_u = gender.upper()
                colour_u = color.upper()

                valid_sizes = {"M", "L", "XL", "XXL", "XXXL", "XXXXL"}
                valid_gender = {"GIR", "WOM"}
                # Use the exact canvas sizes from the legacy C# logic:
                # - Non-HOOD: 4675x5880 (main case) or 3518x4404 (fallback)
                # - HOOD: 4770x3896 (main case) or 4770x2951 (fallback)
                if typ_u != "HOOD":
                    if size_u in valid_sizes and gender_u not in valid_gender:
                        canvas = place_on_canvas(cropped, 4675, 5880, margin=30)
                    else:
                        canvas = place_on_canvas(cropped, 3518, 4404, margin=30)
                else:
                    if size_u in valid_sizes and gender_u not in valid_gender:
                        canvas = place_on_canvas(cropped, 4770, 3896, margin=30)
                    else:
                        canvas = place_on_canvas(cropped, 4770, 2951, margin=30)

                # License text (currently empty, as before)
                license_text = ""
                canvas = draw_license_text_centered(canvas, license_text)

                # Build final dynamic name as in edit_images
                bil_only = bil.split("_")[0] if bil else ""
                dynamic_name = f"{bil_only}-{gender_u}-{typ_u}-{colour_u}-{size_u}.png"
                dynamic_path = final_dir / dynamic_name
                if dynamic_path.exists():
                    continue

                # Render once into memory
                buf = BytesIO()
                canvas.save(buf, format="PNG", optimize=True)
                png_bytes = buf.getvalue()

                # Save to disk for local processing / status checks
                dynamic_path.parent.mkdir(parents=True, exist_ok=True)
                with dynamic_path.open("wb") as f:
                    f.write(png_bytes)
                compress_png_under_size(dynamic_path, 25 * 1024 * 1024)

                # Upload to R2 using a date-based prefix for easier housekeeping
                date_prefix = datetime.now(UTC).strftime("%Y-%m-%d")
                r2_key = f"{date_prefix}/png/{dynamic_name}"
                _upload_to_r2(settings, r2_key, png_bytes, "image/png")
            except Exception as ex:
                msg = (
                    f"Date: {pd.Timestamp.now()}\nError in processing file {fil}\nMessage: {ex}\n"
                )
                _write_log_to_db(settings, "download log", msg)

def create_excel_and_upload(settings: EnvSettings, jobs: list[Job]) -> None:
    image_folder = Path(str(settings.get("FinalPath", "")))
    outputfile = Path(str(settings.get("outputFilePath", "")))

    if not image_folder.exists():
        log_error("Images folder is missing. Please ensure it exists in the application's directory.")
        return

    for job in jobs:
        df = job.raw_df.copy()
        if "status" not in df.columns:
            df["status"] = ""

        contains_issue = False
        issues = []
        for idx, row in df.iterrows():
            inventory_number = str(row.iloc[0]) if len(row) > 0 else ""
            image_path = image_folder / f"{inventory_number}.png"
            exists = image_path.exists()
            df.at[idx, "status"] = "submitted" if exists else "issue"
            if not exists:
                contains_issue = True
                issues.append(f"{inventory_number}: images not found")

        suffix = "-processed" if contains_issue else "-completed"
        out_name = f"{job.csv_path.stem}{suffix}.csv"

        # Serialize CSV in memory, upload directly to SFTP, and back it up to R2.
        csv_bytes = dataframe_to_csv_bytes(df)
        log_error(f"CSV ready to upload to SFTP: {out_name}")
        _upload_csv_bytes_to_sftp(
            csv_bytes=csv_bytes,
            remote_name=out_name,
            sftp_directory=SFTP_DIRECTORY_CSV,
            host=SFTP_HOST,
            port=SFTP_PORT,
            username=SFTP_USERNAME,
            password=SFTP_PASSWORD,
        )

        # Best-effort backup of the final CSV to R2 with a date-based prefix.
        date_prefix = datetime.now(UTC).strftime("%Y-%m-%d")
        r2_csv_key = f"{date_prefix}/csv/{out_name}"
        _upload_to_r2(settings, r2_csv_key, csv_bytes, "text/csv")

        for _, row in df.iterrows():
            inventory_number = str(row.iloc[0]) if len(row) > 0 else ""
            image_path = image_folder / f"{inventory_number}.png"
            if image_path.exists():
                log_error("image  ready to upload" + str(image_path))
                upload_file(
                    local_file_path=image_path,
                    sftp_directory=SFTP_DIRECTORY_IMAGES,
                    host=SFTP_HOST,
                    port=SFTP_PORT,
                    username=SFTP_USERNAME,
                    password=SFTP_PASSWORD,
                )

        file_name = job.csv_path.name
        if issues:
            email_body = f"""
<html>
<body>
<p>Hi,</p>
<p>Few billcode images in file <b>{file_name}</b> appear to be missing from the Box folder. Could you please verify and upload the missing images at your earliest convenience?</p>
<p>Here are the Billcodes:<br>
{'<br>'.join(issues)}
</p>
<p>Regards,<br>
Weblegs Support Team</p>
</body>
</html>
"""
            send_mail(settings.base_dir, email_body, str(out_csv))
        else:
            email_body = f"""
<html>
<body>
<p>Hi,</p>
<p>All the billcode images in file  <b>{file_name}</b> are completed seccussfully</p>
<p>Regards,<br>
Weblegs Support Team</p>
</body>
</html>
"""
            send_mail(settings.base_dir, email_body, "")

def run(argv: list[str] | None = None) -> None:
    argv = argv or []
    settings = load_settings()

    # Ensure mandatory external services are configured.
    try:
        # R2 is required now; this will raise if misconfigured.
        _get_r2_client_and_bucket(settings)
    except Exception as ex:
        log_error(f"Startup configuration error (R2): {ex}")
        return

    log("Enter in MBA_2024 (Python merged)")
    _process_configured_directories(settings)

    # Application 1
    try:
        log("Application 1_ExcelConversion start")
        temp_folder = ensure_dir(settings.base_dir / "Temp")
        downloaded_csvs = download_csvs_and_move_to_processed(
            host=SFTP_HOST,
            port=SFTP_PORT,
            username=SFTP_USERNAME,
            password=SFTP_PASSWORD,
            order_folder=SFTP_ORDER_FOLDER,
            processed_folder=SFTP_PROCESSED_FOLDER,
            local_folder=temp_folder,
        )
        if len(downloaded_csvs) == 0:
            subject = "No CSV Files Found on SFTP Server"
            body = """
<html>
<body>
<p>Hello,</p>
<p>The application checked the SFTP server but did not find any CSV files to process.</p>
<p>Please verify the file availability or the folder contents.</p>
<p>Kind regards,<br/>
Weblegs Support Team</p>
</body>
</html>
"""
            send_notification_email(settings.base_dir, None, body, subject)
            log("No CSV files found on SFTP. Notification email sent.")

        # Build in-memory jobs from CSVs.
        jobs = build_jobs_from_csvs(downloaded_csvs, settings.test_mode)

        # Temp CSV copies are no longer needed after jobs are built.
        shutil.rmtree(temp_folder, ignore_errors=True)
        log("Application  1_ExcelConversion end")
    except Exception as ex:
        log(f"Application 1 Error: {ex}\n{traceback.format_exc()}\n")
        return

    # Application 2
    try:
        log("Application 2_AbsoluteImageProcessApp start")
        # New in-memory flow: enrich jobs.work_df with Box links, and also
        # write report workbooks for downstream steps.
        get_image_link_for_jobs(settings, jobs)
        log("Application 2_AbsoluteImageProcessApp end")
    except Exception as ex:
        log(f"Application 2 Error: {ex}\n{traceback.format_exc()}\n")
        return

    # Application 3 (merged image pipeline: download + normalize + edit)
    try:
        log("Application 3_ImageProcessing start")
        download_images_for_jobs(settings, jobs)
        log("Application 3_ImageProcessing end")
    except Exception as ex:
        log(f"Application 3 Error: {ex}\n{traceback.format_exc()}\n")
        return

    # Application 6
    try:
        log("Application 6_CreateExcel start")
        create_excel_and_upload(settings, jobs)
        log("Application 6_CreateExcel end")
    except Exception as ex:
        log(f"Application 6 Error: {ex}\n{traceback.format_exc()}\n")
        return

    # Final cleanup – only reached if all apps 1–6 succeeded
    try:
        log("Cleanup working directories start")
        _cleanup_working_directories(settings)
        log("Cleanup working directories end")
    except Exception as ex:
        log(f"Cleanup Error: {ex}\n{traceback.format_exc()}\n")


if __name__ == "__main__":
    import sys

    raise SystemExit(run(sys.argv[1:]))


