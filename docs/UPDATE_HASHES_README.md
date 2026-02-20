# Attack Map - Integrity Hash Updater

## Overview

`update_hashes.py` is a utility tool that automatically updates SHA384 integrity hashes for all static assets referenced in `index.html`. This ensures Content Security Policy (CSP) compliance and prevents the need for manual hash calculations.

## Features

- ✅ Automatically detects all files with integrity attributes
- ✅ Calculates SHA384 hashes using the same method as OpenSSL
- ✅ Handles query parameters in file paths (e.g., `?v=5`)
- ✅ Provides colored, formatted output for easy reading
- ✅ Supports check-only mode to preview changes
- ✅ Verbose mode to see all files (not just changes)
- ✅ Proper error handling and reporting

## Files Currently Tracked

The tool automatically updates hashes for the following files:

### JavaScript Libraries
- `static/d3.v7.min.js`
- `static/jquery-3.7.1.min.js`
- `static/luxon.min.js`
- `static/chart.umd.js`
- `static/bootstrap.min.js`
- `static/leaflet.js`
- `static/leaflet.fullscreen.js`

### Custom JavaScript
- `static/cache-bridge.js`
- `static/map.js`
- `static/dashboard.js`

### CSS Files
- `static/bootstrap.min.css`
- `static/leaflet.css`
- `static/leaflet.fullscreen.css`
- `static/fonts/fonts.css`
- `static/fontawesome/css/all.min.css`
- `static/index.css`

## Usage

### Basic Usage
Update all integrity hashes in index.html:
```bash
python3 update_hashes.py
```

### Check Mode
Preview which files would be updated without making changes:
```bash
python3 update_hashes.py --check
```

### Verbose Mode
Show all files, including those that don't need updating:
```bash
python3 update_hashes.py --verbose
```

### Combined Modes
Check all files with detailed output:
```bash
python3 update_hashes.py --check --verbose
```

### Help
Display usage information:
```bash
python3 update_hashes.py --help
```

## Output Explanation

The tool provides color-coded output:

- 🟢 **Green checkmark (✓)**: File hash is up-to-date
- 🟡 **Yellow lightning (⚡)**: File hash needs updating
- 🔴 **Red X (✗)**: Error occurred (file not found, etc.)

### Example Output

```
Attack Map - Integrity Hash Updater
============================================================

🔄 Updating integrity hashes...

⚡ static/dashboard.js
  Old: sha384-vWCBuKL1BmtmDRTWz+chtEo6Y1R2FQ6DKkFuyA+Ur/MldbNNZ9+CjBIhQ9W/N3k7
  New: sha384-Xdqg0LrZrcKsW3rsFYsvLmCzvxc1hSUk/ZINNG8ZLjryNMOmfCS3z/AllglGGFa9

============================================================
Summary:
  Total files:     16
  Unchanged:       15
  Need updating:   1
  Errors:          0

✓ Successfully updated static/index.html
```

## When to Use

Run this tool whenever you modify:
- Any JavaScript file in the `static/` directory
- Any CSS file in the `static/` directory
- Font files or other assets with integrity attributes

## Integration with Development Workflow

### Recommended Workflow

1. **Make changes** to any static files (e.g., `dashboard.js`, `map.js`, `index.css`)
2. **Check what needs updating**:
   ```bash
   python3 update_hashes.py --check
   ```
3. **Update the hashes**:
   ```bash
   python3 update_hashes.py
   ```
4. **Commit the changes** including both the modified files and `index.html`

### Pre-commit Hook (Optional)

You can automate this by adding a git pre-commit hook:

```bash
#!/bin/sh
# .git/hooks/pre-commit

# Check if any static files were modified
if git diff --cached --name-only | grep -q "^static/"; then
    echo "Static files modified, updating integrity hashes..."
    python3 update_hashes.py

    # Stage the updated index.html
    git add static/index.html
fi
```

## Technical Details

### Hash Calculation Method

The tool uses Python's `hashlib` library to calculate SHA384 hashes, which produces identical results to the OpenSSL command:

```bash
openssl dgst -sha384 -binary <file> | openssl base64 -A
```

### Path Resolution

The tool intelligently handles path resolution:
- Detects that `index.html` is in the `static/` directory
- Strips the `static/` prefix from file paths to avoid double-pathing
- Removes query parameters (e.g., `?v=5`) before file lookup
- Uses absolute paths to avoid working directory issues

### Regex Pattern

The tool uses the following regex to extract integrity attributes:
```regex
(?:src|href)="(static/[^"]+)"[^>]*?integrity="(sha384-[^"]+)"
```

This matches both `<script>` and `<link>` tags with integrity attributes.

## Troubleshooting

### File Not Found Errors

If you see "File not found" errors:
1. Verify the file exists in the `static/` directory
2. Check that the file path in `index.html` is correct
3. Ensure you're running the script from the project root directory

### Permission Denied

If you get permission errors:
```bash
chmod +x update_hashes.py
```

### No Changes Detected

If the tool reports all files unchanged but you know you modified a file:
1. Verify you saved the file
2. Check that the file path matches exactly what's in `index.html`
3. Run with `--verbose` to see details about all files

## Requirements

- Python 3.6 or higher
- Standard library only (no external dependencies)

## License

This tool is part of the Attack Map project.
