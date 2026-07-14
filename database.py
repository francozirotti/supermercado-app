"""Acceso a la base de datos SQLite de la app."""
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "gastos.db"
SCHEMA_PATH = BASE_DIR / "schema.sql"


def get_connection():
    """Abre una conexión nueva a la base de datos con filas tipo dict."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """Crea las tablas si no existen y aplica migraciones ligeras.
    Seguro de llamar en cada arranque, incluso sobre una base ya en uso."""
    conn = get_connection()
    try:
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            conn.executescript(f.read())
        conn.commit()
        _run_migrations(conn)
    finally:
        conn.close()


def _run_migrations(conn):
    """Ajustes a bases de datos creadas con una versión anterior del esquema."""
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(tickets)").fetchall()}
    if "settlement_period_id" not in columns:
        conn.execute("ALTER TABLE tickets ADD COLUMN settlement_period_id INTEGER")
        conn.commit()
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tickets_period_id ON tickets(settlement_period_id)"
    )
    conn.commit()
