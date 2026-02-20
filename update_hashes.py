#!/usr/bin/env python3
"""
Attack Map - Integrity Hash Updater
==========================================
Automatically updates SHA384 integrity hashes for all static assets in index.html

Usage:
    python3 update_hashes.py              # Update all hashes
    python3 update_hashes.py --check      # Check which files need updating
    python3 update_hashes.py --verbose    # Show detailed output
"""

import re
import hashlib
import base64
import sys
import os
from pathlib import Path
from typing import List, Tuple, Dict

# ANSI color codes for pretty output
class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def calculate_sha384(file_path: str) -> str:
    """
    Calculate SHA384 hash for a file and return as base64-encoded string.

    Args:
        file_path: Path to the file to hash

    Returns:
        Base64-encoded SHA384 hash in format: sha384-<hash>
    """
    try:
        with open(file_path, 'rb') as f:
            file_data = f.read()
            sha384_hash = hashlib.sha384(file_data).digest()
            base64_hash = base64.b64encode(sha384_hash).decode('utf-8')
            return f"sha384-{base64_hash}"
    except FileNotFoundError:
        print(f"{Colors.FAIL}✗ File not found: {file_path}{Colors.ENDC}")
        return None
    except Exception as e:
        print(f"{Colors.FAIL}✗ Error calculating hash for {file_path}: {e}{Colors.ENDC}")
        return None

def extract_integrity_entries(html_content: str) -> List[Tuple[str, str, str]]:
    """
    Extract all integrity attribute entries from HTML content.

    Args:
        html_content: The HTML file content

    Returns:
        List of tuples: (file_path, current_hash, full_match_string)
    """
    # Pattern to match both <link> and <script> tags with integrity attributes
    # Handles various formats: src="...", href="...", integrity="..."
    pattern = r'(?:src|href)="(static/[^"]+)"[^>]*?integrity="(sha384-[^"]+)"'

    matches = []
    for match in re.finditer(pattern, html_content):
        file_path = match.group(1)
        current_hash = match.group(2)
        full_match = match.group(0)
        matches.append((file_path, current_hash, full_match))

    return matches

def update_integrity_hashes(html_file: str, check_only: bool = False, verbose: bool = False) -> bool:
    """
    Update all integrity hashes in the HTML file.

    Args:
        html_file: Path to the HTML file
        check_only: If True, only check which files need updating without modifying
        verbose: If True, show detailed output for all files

    Returns:
        True if successful (or if check_only and no changes needed), False otherwise
    """
    # Read the HTML file
    try:
        with open(html_file, 'r', encoding='utf-8') as f:
            html_content = f.read()
    except FileNotFoundError:
        print(f"{Colors.FAIL}✗ HTML file not found: {html_file}{Colors.ENDC}")
        return False

    # Get the directory of the HTML file for resolving relative paths
    html_dir = Path(html_file).parent

    # Extract all integrity entries
    entries = extract_integrity_entries(html_content)

    if not entries:
        print(f"{Colors.WARNING}⚠ No integrity attributes found in {html_file}{Colors.ENDC}")
        return False

    print(f"{Colors.HEADER}{Colors.BOLD}Attack Map - Integrity Hash Updater{Colors.ENDC}")
    print(f"{Colors.HEADER}{'=' * 60}{Colors.ENDC}\n")

    if check_only:
        print(f"{Colors.OKBLUE}🔍 Checking integrity hashes...{Colors.ENDC}\n")
    else:
        print(f"{Colors.OKBLUE}🔄 Updating integrity hashes...{Colors.ENDC}\n")

    # Track statistics
    stats = {
        'total': len(entries),
        'updated': 0,
        'unchanged': 0,
        'errors': 0
    }

    # Store updates to apply
    updates: Dict[str, str] = {}

    # Process each entry
    for file_path, current_hash, full_match in entries:
        # Remove query parameters from file path (e.g., ?v=5)
        clean_file_path = file_path.split('?')[0]

        # Resolve the full path
        # If HTML file is already in static/, don't add static/ again
        if 'static' in str(html_dir).lower() and clean_file_path.startswith('static/'):
            # Remove 'static/' prefix since we're already in the static directory
            relative_path = clean_file_path.replace('static/', '', 1)
            full_path = html_dir / relative_path
        else:
            full_path = html_dir / clean_file_path

        # Calculate new hash
        new_hash = calculate_sha384(str(full_path))

        if new_hash is None:
            stats['errors'] += 1
            continue

        # Check if hash changed
        if current_hash == new_hash:
            stats['unchanged'] += 1
            if verbose:
                print(f"{Colors.OKGREEN}✓ {file_path}{Colors.ENDC}")
                print(f"  Hash: {Colors.OKCYAN}{current_hash}{Colors.ENDC}")
                print()
        else:
            stats['updated'] += 1
            print(f"{Colors.WARNING}⚡ {file_path}{Colors.ENDC}")
            print(f"  Old: {Colors.FAIL}{current_hash}{Colors.ENDC}")
            print(f"  New: {Colors.OKGREEN}{new_hash}{Colors.ENDC}")
            print()

            # Store the update
            old_pattern = full_match.replace(current_hash, r'sha384-[A-Za-z0-9+/=]+')
            new_text = full_match.replace(current_hash, new_hash)
            updates[full_match] = new_text

    # Print summary
    print(f"{Colors.HEADER}{'=' * 60}{Colors.ENDC}")
    print(f"{Colors.BOLD}Summary:{Colors.ENDC}")
    print(f"  Total files:     {stats['total']}")
    print(f"  {Colors.OKGREEN}Unchanged:       {stats['unchanged']}{Colors.ENDC}")
    print(f"  {Colors.WARNING}Need updating:   {stats['updated']}{Colors.ENDC}")
    print(f"  {Colors.FAIL}Errors:          {stats['errors']}{Colors.ENDC}")
    print()

    # Apply updates if not check_only mode
    if not check_only and updates:
        try:
            updated_content = html_content
            for old_text, new_text in updates.items():
                updated_content = updated_content.replace(old_text, new_text)

            # Write back to file
            with open(html_file, 'w', encoding='utf-8') as f:
                f.write(updated_content)

            print(f"{Colors.OKGREEN}✓ Successfully updated {html_file}{Colors.ENDC}")
            return True
        except Exception as e:
            print(f"{Colors.FAIL}✗ Error writing to {html_file}: {e}{Colors.ENDC}")
            return False
    elif check_only and stats['updated'] > 0:
        print(f"{Colors.WARNING}⚠ Run without --check to update the hashes{Colors.ENDC}")
        return False

    return stats['updated'] == 0

def main():
    """Main entry point."""
    # Parse command line arguments
    check_only = '--check' in sys.argv
    verbose = '--verbose' in sys.argv or '-v' in sys.argv

    # Show help if requested
    if '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
        return

    # Determine HTML file path
    script_dir = Path(__file__).parent
    html_file = script_dir / 'static' / 'index.html'

    # Run the updater
    success = update_integrity_hashes(str(html_file), check_only=check_only, verbose=verbose)

    # Exit with appropriate code
    sys.exit(0 if success else 1)

if __name__ == '__main__':
    main()
