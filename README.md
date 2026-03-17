## MBA_2024 Python pipeline

This script (`mba_2024.py`) automates the full image + CSV processing flow
for MBA_2024:

- Downloads CSV order files from SFTP.
- Parses inventory numbers into structured fields (Bilcode, Gender, Type, Color, Size).
- Calls Box (JWT) to find matching artwork and generates image links.
- Downloads and edits images (background removal, canvas placement, license text).
- Uploads final images and a status CSV back to SFTP.

### Inputs

- **SFTP CSVs**: from `SFTP_ORDER_FOLDER` (e.g. `/orders/`).
  - Each CSV is expected to have the inventory string in the first column,
    formatted like `BIL-GENDER-TYPE-COLOR-SIZE`.

### Outputs

All final outputs are sent back to SFTP:

- **Final CSV** (per input CSV) to `SFTP_DIRECTORY_CSV`
  - Name: `<original_name>-completed.csv` or `<original_name>-processed.csv`
  - Contains original rows + a `status` column (`submitted` / `issue`).
- **Final PNG images** (per row with an image) to `SFTP_DIRECTORY_IMAGES`
  - Name: `BIL-GENDER-TYPE-COLOUR-SIZE.png`.

Locally, the script uses:

- `FinalPath` as a temporary staging folder for PNGs.
- `outputFilePath` is no longer used for disk storage; CSVs are streamed directly
  to SFTP from memory.

### Required `.env` keys

The script loads configuration from `.env` in the same folder:

- **General**
  - `TestMode` (true/false) – when true, only processes up to 20 rows per CSV.
  - `LogEnabled` (true/false) – basic flag for logging usage.

- **Folders / paths**
  - `FinalPath` – local folder for final PNGs (e.g. `/app/output/images` on Railway;
    on Windows dev you can point this to a Windows path).
  - `outputFilePath` – kept for compatibility; final CSVs are sent directly
    to SFTP, not stored here (e.g. `/app/output/excel`).
  - No log file paths are required. All logs (from `log`, `log_error`, and download
    failures) are stored only in the database table `MBA_Loges`.

- **Gmail OAuth (optional, for email sending)**
  - By default, the app looks for `credentials.json` and `token.json` in the same
    folder as `mba_2024.py`.
  - You can override these with:
    - `GMAIL_CREDENTIALS_JSON` – full path to your Gmail client secret JSON.
    - `GMAIL_TOKEN_PATH` – full path where the Gmail OAuth token should be stored.

- **Cloudflare R2 (required backups for outputs)**
  - `R2_ENDPOINT` – S3-compatible endpoint for your R2 account.
  - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` – R2 API credentials.
  - `R2_BUCKET` – bucket name where PNG/CSV backups are stored under
    `YYYY-MM-DD/png/...` and `YYYY-MM-DD/csv/...`. If these are missing or
    invalid, the app will log a startup error and exit so you notice.

- **Database (PostgreSQL, for MBA_Loges table)**
  - `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT` – used to insert log
    rows into table `MBA_Loges` (columns: `id` auto, `log_type` `log` / `log error`,
    `error` log text). If any is missing, DB logging is skipped.

- **SFTP**
  - `SFTP_HOST`
  - `SFTP_PORT`
  - `SFTP_USERNAME`
  - `SFTP_PASSWORD`
  - `SFTP_ORDER_FOLDER` – source folder for CSVs (e.g. `/orders/`).
  - `SFTP_PROCESSED_FOLDER` – where CSVs are moved after download.
  - `SFTP_DIRECTORY_CSV` – destination for final CSVs.
  - `SFTP_DIRECTORY_IMAGES` – destination for final PNGs.

- **Box / JWT**
  - `BOX_CREDENTIALS_JSON` – path to the Box JWT config JSON.
  - `BOX_USER_ID` – Box user ID for impersonation.

### High-level flow

1. **Application 1 — ExcelConversion (CSV → jobs)**
   - Downloads CSVs from SFTP and moves them to the processed folder.
   - Reads each CSV into a `Job`:
     - `raw_df` – full CSV data.
     - `work_df` – parsed Bilcode/Gender/Type/Color/Size.

2. **Application 2 — AbsoluteImageProcessApp (Box links)**
   - For each `job.work_df` row, calls Box to find matching artwork.
   - Fills columns: `"png file"`, `"psd file"`, `"ai file"`, `"tif file"`,
     `"Image Link"`, `"Pocket Print"`, `"No Image Found"`.

3. **Application 3 — ImageProcessing (download + edit)**
   - For each row with an `Image Link`:
     - Downloads the image to memory.
     - Normalizes to PNG with RGBA.
     - Removes plain white/light background.
     - Crops to content and places on a canvas (size based on type/size/gender).
     - Optionally draws license text (currently empty).
     - Saves the final PNG to `FinalPath` and compresses under 25 MB.

4. **Application 6 — CreateExcel (final CSV + uploads)**
   - For each `job.raw_df`:
     - Adds `status` per row based on whether a matching PNG exists in `FinalPath`.
     - Serializes the DataFrame to CSV bytes.
     - Streams CSV directly to SFTP with retry + email on failure.
     - Uploads each PNG in `FinalPath` to SFTP (also with retry + email on failure).
     - Sends an email summary for missing/complete images.

5. **Cleanup**
   - After all applications succeed, temporary folders (`FinalPath`, `outputFilePath`)
     are deleted by `_cleanup_working_directories`.

### Notes

- The `.env` file contains SFTP credentials and should **never** be committed to
  source control. Make sure `.gitignore` includes `.env`.

