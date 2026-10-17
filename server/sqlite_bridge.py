#!/usr/bin/env python3
"""
Persistent SQLite3 ACID Worker Bridge for Node.js (`server/sqlite_bridge.py`)
Uses Python's built-in C `sqlite3` library when native Node.js SQLite addons
(`node:sqlite`, `better-sqlite3`, `sqlite3`) are not installed.

Supports:
- Real SQLite3 database files on disk (`SQLITE_PATH`) with WAL mode & foreign keys
- Explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` ACID transactions
- Parameterized SQL queries (`?` placeholders) returning rows as dicts
"""
import json
import os
import sqlite3
import sys

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: sqlite_bridge.py <sqlite_db_path>\n")
        sys.exit(1)

    db_path = sys.argv[1]
    if db_path != ":memory:":
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)

    conn = sqlite3.connect(db_path, timeout=10.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL;")
    cur.execute("PRAGMA synchronous=NORMAL;")
    cur.execute("PRAGMA foreign_keys=ON;")
    cur.execute("PRAGMA busy_timeout=5000;")

    # Signal ready
    sys.stdout.write(json.dumps({"ready": True, "sqlite_version": sqlite3.sqlite_version}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = req.get("cmd")

            if cmd == "exec_script":
                sql_script = req.get("sql", "")
                cur.executescript(sql_script)
                resp = {"id": req_id, "ok": True}

            elif cmd == "query":
                sql = req.get("sql", "")
                params = req.get("params", [])
                cur.execute(sql, params)
                if cur.description:
                    rows = [dict(r) for r in cur.fetchall()]
                else:
                    rows = []
                resp = {
                    "id": req_id,
                    "ok": True,
                    "rows": rows,
                    "rowcount": cur.rowcount,
                    "lastrowid": cur.lastrowid,
                }

            elif cmd == "begin":
                cur.execute("BEGIN IMMEDIATE")
                resp = {"id": req_id, "ok": True}

            elif cmd == "commit":
                cur.execute("COMMIT")
                resp = {"id": req_id, "ok": True}

            elif cmd == "rollback":
                try:
                    cur.execute("ROLLBACK")
                except Exception:
                    pass
                resp = {"id": req_id, "ok": True}

            elif cmd == "close":
                conn.close()
                sys.stdout.write(json.dumps({"id": req_id, "ok": True}) + "\n")
                sys.stdout.flush()
                break

            else:
                resp = {"id": req_id, "ok": False, "error": f"Unknown command: {cmd}"}

        except Exception as exc:
            resp = {"id": req_id, "ok": False, "error": str(exc)}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
