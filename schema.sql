-- Esquema de la base de datos para la app de gastos de supermercado compartidos

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Un "período" queda cerrado cada vez que se hace el reparto de dinero y se
-- vuelve a cero. Guarda una foto fija del resumen en ese momento (balances y
-- pagos sugeridos), para poder consultarlo después en el Histórico aunque
-- los tickets sigan existiendo o se sigan editando.
CREATE TABLE IF NOT EXISTS settlement_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    closed_at TEXT NOT NULL DEFAULT (datetime('now')),
    total_shared REAL NOT NULL,
    fair_share REAL NOT NULL,
    balances_json TEXT NOT NULL,
    settlements_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store TEXT,
    ticket_date TEXT,
    image_filename TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- NULL = ticket activo (cuenta para el resumen actual).
    -- Con valor = quedó archivado dentro de ese período ya repartido.
    settlement_period_id INTEGER REFERENCES settlement_periods(id)
);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    included INTEGER NOT NULL DEFAULT 1  -- 1 = va a la cuenta común, 0 = consumo personal
);

CREATE INDEX IF NOT EXISTS idx_items_ticket_id ON items(ticket_id);
CREATE INDEX IF NOT EXISTS idx_tickets_owner_id ON tickets(owner_id);
-- El índice de settlement_period_id se crea en database.py, después de la
-- migración, porque en bases de datos antiguas esa columna no existe todavía
-- en el momento en que este script corre.
