"""App de gastos de supermercado compartidos.

Flujo:
1. Cada persona sube una foto de su ticket e indica de quién es.
2. Claude Vision lee el ticket y devuelve una VISTA PREVIA editable (nada se
   guarda todavía). Se revisan los ítems, se marca qué va a la cuenta común,
   y solo al presionar "Crear ticket" queda guardado de verdad.
3. También se puede crear un ticket "sin respaldo" (sin foto), poniendo
   solo el monto total, para cuando se pierde el ticket físico.
4. El botón "Resumen" muestra cuánto pagó cada uno y quién le debe a quién.
5. Al hacer el reparto real de dinero, "Repartir y volver a cero" archiva
   los tickets activos en el Histórico y el resumen actual queda en cero.
"""
import json
import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

import database
import ocr
from settlement import build_summary

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
STATIC_DIR = BASE_DIR / "static"
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "heic", "heif"}

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")

# Se ejecuta siempre al importar este módulo (tanto con "python app.py" como
# con Gunicorn/systemd en producción), no solo en modo desarrollo. Si no,
# Gunicorn nunca crea las tablas nuevas ni corre las migraciones.
database.init_db()


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------- Frontend ----------

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


# ---------- Usuarios ----------

@app.route("/api/users", methods=["GET"])
def list_users():
    conn = database.get_connection()
    try:
        rows = conn.execute("SELECT id, name FROM users ORDER BY name").fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@app.route("/api/users", methods=["POST"])
def create_user():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre no puede estar vacío"}), 400

    conn = database.get_connection()
    try:
        existing = conn.execute(
            "SELECT id, name FROM users WHERE name = ?", (name,)
        ).fetchone()
        if existing:
            return jsonify(dict(existing)), 200

        cur = conn.execute("INSERT INTO users (name) VALUES (?)", (name,))
        conn.commit()
        return jsonify({"id": cur.lastrowid, "name": name}), 201
    finally:
        conn.close()


@app.route("/api/users/<int:user_id>", methods=["DELETE"])
def delete_user(user_id):
    conn = database.get_connection()
    try:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------- Lectura de ticket (vista previa, no guarda nada) ----------

@app.route("/api/ocr/preview", methods=["POST"])
def ocr_preview():
    if "image" not in request.files:
        return jsonify({"error": "Falta el archivo 'image'"}), 400

    file = request.files["image"]
    if file.filename == "" or not allowed_file(file.filename):
        return jsonify({"error": "Formato de imagen no soportado"}), 400

    image_bytes = file.read()
    try:
        extracted = ocr.extract_items_from_image(image_bytes)
    except Exception as exc:  # noqa: BLE001 - se lo mostramos tal cual al usuario
        return jsonify({"error": f"No se pudo leer el ticket: {exc}"}), 502

    return jsonify(extracted)


# ---------- Tickets ----------

def _serialize_ticket(conn, ticket_row):
    items = conn.execute(
        "SELECT id, name, price, included FROM items WHERE ticket_id = ? ORDER BY id",
        (ticket_row["id"],),
    ).fetchall()
    owner = conn.execute(
        "SELECT name FROM users WHERE id = ?", (ticket_row["owner_id"],)
    ).fetchone()
    total_incluido = sum(i["price"] for i in items if i["included"])
    total_ticket = sum(i["price"] for i in items)
    return {
        "id": ticket_row["id"],
        "owner_id": ticket_row["owner_id"],
        "owner_name": owner["name"] if owner else None,
        "store": ticket_row["store"],
        "ticket_date": ticket_row["ticket_date"],
        "created_at": ticket_row["created_at"],
        "image_filename": ticket_row["image_filename"],
        "settlement_period_id": ticket_row["settlement_period_id"],
        "items": [
            {
                "id": i["id"],
                "name": i["name"],
                "price": i["price"],
                "included": bool(i["included"]),
            }
            for i in items
        ],
        "total_ticket": round(total_ticket, 2),
        "total_incluido": round(total_incluido, 2),
    }


@app.route("/api/tickets", methods=["GET"])
def list_tickets():
    period_id = request.args.get("period_id")
    conn = database.get_connection()
    try:
        # Se ordena por la fecha de la factura (ticket_date) de más reciente a
        # más antigua; los tickets sin fecha (p. ej. si la IA no la detectó)
        # quedan al final, ordenados entre sí por fecha de creación.
        order_clause = (
            "ORDER BY (ticket_date IS NULL) ASC, ticket_date DESC, created_at DESC"
        )
        if period_id:
            rows = conn.execute(
                f"SELECT * FROM tickets WHERE settlement_period_id = ? {order_clause}",
                (period_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT * FROM tickets WHERE settlement_period_id IS NULL {order_clause}"
            ).fetchall()
        return jsonify([_serialize_ticket(conn, r) for r in rows])
    finally:
        conn.close()


@app.route("/api/tickets", methods=["POST"])
def create_ticket():
    """Crea el ticket YA REVISADO por el usuario. Puede venir con foto
    (flujo normal, tras la vista previa de /api/ocr/preview) o sin ella
    (ticket "sin respaldo", solo con un monto puesto a mano)."""
    owner_id = request.form.get("owner_id")
    if not owner_id:
        return jsonify({"error": "Falta owner_id (de quién es el ticket)"}), 400

    items_raw = request.form.get("items")
    if not items_raw:
        return jsonify({"error": "Falta la lista de ítems"}), 400
    try:
        items = json.loads(items_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "El campo 'items' no es JSON válido"}), 400
    if not isinstance(items, list) or len(items) == 0:
        return jsonify({"error": "El ticket necesita al menos un ítem"}), 400

    store = request.form.get("store") or None
    ticket_date = request.form.get("ticket_date") or None

    saved_filename = None
    image_file = request.files.get("image")
    if image_file and image_file.filename:
        if not allowed_file(image_file.filename):
            return jsonify({"error": "Formato de imagen no soportado"}), 400
        ext = image_file.filename.rsplit(".", 1)[1].lower()
        saved_filename = f"{uuid.uuid4().hex}.{ext}"
        image_file.save(UPLOAD_DIR / saved_filename)

    conn = database.get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO tickets (owner_id, store, ticket_date, image_filename) "
            "VALUES (?, ?, ?, ?)",
            (owner_id, store, ticket_date, saved_filename),
        )
        ticket_id = cur.lastrowid
        for item in items:
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            try:
                price = round(float(item.get("price", 0)), 2)
            except (TypeError, ValueError):
                price = 0.0
            included = 1 if item.get("included", True) else 0
            conn.execute(
                "INSERT INTO items (ticket_id, name, price, included) VALUES (?, ?, ?, ?)",
                (ticket_id, name, price, included),
            )
        conn.commit()

        ticket_row = conn.execute(
            "SELECT * FROM tickets WHERE id = ?", (ticket_id,)
        ).fetchone()
        return jsonify(_serialize_ticket(conn, ticket_row)), 201
    finally:
        conn.close()


@app.route("/api/tickets/<int:ticket_id>", methods=["DELETE"])
def delete_ticket(ticket_id):
    conn = database.get_connection()
    try:
        conn.execute("DELETE FROM tickets WHERE id = ?", (ticket_id,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------- Ítems (edición de tickets ya creados) ----------

@app.route("/api/items/<int:item_id>", methods=["PUT"])
def update_item(item_id):
    data = request.get_json(force=True) or {}
    conn = database.get_connection()
    try:
        item = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if not item:
            return jsonify({"error": "Ítem no encontrado"}), 404

        name = data.get("name", item["name"])
        price = data.get("price", item["price"])
        included = data.get("included", bool(item["included"]))

        conn.execute(
            "UPDATE items SET name = ?, price = ?, included = ? WHERE id = ?",
            (name, price, 1 if included else 0, item_id),
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return jsonify(
            {
                "id": updated["id"],
                "name": updated["name"],
                "price": updated["price"],
                "included": bool(updated["included"]),
            }
        )
    finally:
        conn.close()


@app.route("/api/tickets/<int:ticket_id>/items", methods=["POST"])
def add_item(ticket_id):
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    try:
        price = round(float(data.get("price", 0)), 2)
    except (TypeError, ValueError):
        return jsonify({"error": "Precio inválido"}), 400
    if not name:
        return jsonify({"error": "El nombre del ítem no puede estar vacío"}), 400

    conn = database.get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO items (ticket_id, name, price, included) VALUES (?, ?, ?, 1)",
            (ticket_id, name, price),
        )
        conn.commit()
        return jsonify({"id": cur.lastrowid, "name": name, "price": price, "included": True}), 201
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>", methods=["DELETE"])
def delete_item(item_id):
    conn = database.get_connection()
    try:
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------- Resumen y liquidación ----------

def _current_paid_by_user(conn):
    users = [dict(r) for r in conn.execute("SELECT id, name FROM users").fetchall()]
    rows = conn.execute(
        """
        SELECT t.owner_id AS owner_id, SUM(i.price) AS total
        FROM items i
        JOIN tickets t ON i.ticket_id = t.id
        WHERE i.included = 1 AND t.settlement_period_id IS NULL
        GROUP BY t.owner_id
        """
    ).fetchall()
    paid_by_user_id = {r["owner_id"]: (r["total"] or 0.0) for r in rows}
    return users, paid_by_user_id


@app.route("/api/summary", methods=["GET"])
def summary():
    conn = database.get_connection()
    try:
        users, paid_by_user_id = _current_paid_by_user(conn)
        return jsonify(build_summary(users, paid_by_user_id))
    finally:
        conn.close()


@app.route("/api/settlement/close", methods=["POST"])
def close_settlement():
    """Archiva los tickets activos en un nuevo período del histórico y
    deja el resumen actual en cero."""
    conn = database.get_connection()
    try:
        users, paid_by_user_id = _current_paid_by_user(conn)
        result = build_summary(users, paid_by_user_id)

        if result["total_shared"] <= 0:
            return jsonify({"error": "No hay gastos activos para repartir"}), 400

        cur = conn.execute(
            """
            INSERT INTO settlement_periods
                (total_shared, fair_share, balances_json, settlements_json)
            VALUES (?, ?, ?, ?)
            """,
            (
                result["total_shared"],
                result["fair_share"],
                json.dumps(result["balances"], ensure_ascii=False),
                json.dumps(result["settlements"], ensure_ascii=False),
            ),
        )
        period_id = cur.lastrowid

        conn.execute(
            "UPDATE tickets SET settlement_period_id = ? WHERE settlement_period_id IS NULL",
            (period_id,),
        )
        conn.commit()

        period_row = conn.execute(
            "SELECT * FROM settlement_periods WHERE id = ?", (period_id,)
        ).fetchone()
        return jsonify(_serialize_period(period_row)), 201
    finally:
        conn.close()


def _serialize_period(row):
    return {
        "id": row["id"],
        "closed_at": row["closed_at"],
        "total_shared": row["total_shared"],
        "fair_share": row["fair_share"],
        "balances": json.loads(row["balances_json"]),
        "settlements": json.loads(row["settlements_json"]),
    }


@app.route("/api/settlement/history", methods=["GET"])
def settlement_history():
    conn = database.get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM settlement_periods ORDER BY closed_at DESC"
        ).fetchall()
        return jsonify([_serialize_period(r) for r in rows])
    finally:
        conn.close()


# ---------- Imágenes subidas (para revisar el ticket original) ----------

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
