#!/usr/bin/env python3
"""CLI tool to create or promote an Admin Account for Chat-with-Books."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Add ui/ to python path
ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "ui"))

import accounts
import audit


def main():
    parser = argparse.ArgumentParser(description="Create or manage an Admin account.")
    parser.add_argument("--email", "-e", help="Admin email address", required=False)
    parser.add_argument("--password", "-p", help="Admin password", required=False)
    parser.add_argument("--phone", help="Optional attached phone number", required=False)
    args = parser.parse_args()

    email = args.email
    password = args.password
    phone = args.phone

    if not email:
        email = input("Enter admin email: ").strip()
    if not password:
        import getpass
        password = getpass.getpass("Enter admin password: ")

    email = email.strip().lower()
    if not email or "@" not in email:
        sys.stderr.write("Error: A valid email address is required.\n")
        sys.exit(1)

    if not password:
        sys.stderr.write("Error: Password cannot be empty.\n")
        sys.exit(1)

    existing = accounts.account_by_email(email)
    if existing:
        if existing.get("role") == "admin":
            print(f"Account '{email}' is already an admin.")
            sys.exit(0)
        else:
            # Promote existing operator to admin
            conn = accounts._connect()
            try:
                conn.execute(
                    "UPDATE accounts SET role = 'admin', password_hash = ? WHERE email = ?",
                    (accounts.hash_password(password), email),
                )
                if phone:
                    conn.execute("UPDATE accounts SET phone = ? WHERE email = ?", (phone, email))
                conn.commit()
            finally:
                conn.close()
            try:
                audit.append(
                    audit.ADMIN_SEEDED,
                    actor_email="cli",
                    detail={"email": email, "action": "promoted_to_admin"},
                )
            except Exception:
                pass
            print(f"Successfully promoted '{email}' to admin!")
            sys.exit(0)

    created = accounts.create_account(email, password, phone=phone, role="admin")
    if created is None:
        sys.stderr.write(f"Error: Failed to create admin account for '{email}'.\n")
        sys.exit(1)

    try:
        audit.append(
            audit.ACCOUNT_CREATED,
            actor_email="cli",
            detail={"email": email, "role": "admin", "phone": phone},
        )
    except Exception:
        pass
    print(f"Admin account successfully created: {email}")


if __name__ == "__main__":
    main()
