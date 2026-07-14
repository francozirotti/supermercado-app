"""App de gastos de supermercado compartidos.

Flujo:
1. Cada persona sube una foto de su ticket e indica de quién es.
2. Claude Vision lee el ticket y extrae los ítems con precio.
3. Cada ítem tiene un checkbox: si va a la cuenta común o es consumo personal.
4. El botón "Resumen" muestra cuánto pagó cada uno (solo ítems marcados) y
   quién le debe a quién para que todos terminen habiendo puesto lo mismo.
"""
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
    conn = database.get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM tickets ORDER BY created_at DESC"
        ).fetchall()
        return jsonify([_serialize_ticket(conn, r) for r in rows])
    finally:
        conn.close()


@app.route("/api/tickets", methods=["POST"])
def upload_ticket():
    if "image" not in request.files:
        return jsonify({"error": "Falta el archivo 'image'"}), 400

    file = request.files["image"]
    owner_id = request.form.get("owner_id")
    if not owner_id:
        return jsonify({"error": "Falta owner_id (de quién es el ticket)"}), 400
    if file.filename == "" or not allowed_file(file.filename):
        return jsonify({"error": "Formato de imagen no soportado"}), 400

    image_bytes = file.read()

    try:
        extracted = ocr.extract_items_from_image(image_bytes)
    except Exception as exc:  # noqa: BLE001 - queremos devolver el error al frontend
        return jsonify({"error": f"No se pudo leer el ticket: {exc}"}), 502

    ext = file.filename.rsplit(".", 1)[1].lower()
    saved_filename = f"{uuid.uuid4().hex}.{ext}"
    with open(UPLOAD_DIR / saved_filename, "wb") as f:
        f.write(image_bytes)

    conn = database.get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO tickets (owner_id, store, ticket_date, image_filename) "
            "VALUES (?, ?, ?, ?)",
            (owner_id, extracted.get("store"), extracted.get("date"), saved_filename),
        )
        ticket_id = cur.lastrowid
        for item in extracted["items"]:
            conn.execute(
                "INSERT INTO items (ticket_id, name, price, included) VALUES (?, ?, ?, 1)",
                (ticket_id, item["name"], item["price"]),
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


# ---------- Ítems ----------

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

@app.route("/api/summary", methods=["GET"])
def summary():
    conn = database.get_connection()
    try:
        users = [dict(r) for r in conn.execute("SELECT id, name FROM users").fetchall()]
        rows = conn.execute(
            """
            SELECT t.owner_id AS owner_id, SUM(i.price) AS total
            FROM items i
            JOIN tickets t ON i.ticket_id = t.id
            WHERE i.included = 1
            GROUP BY t.owner_id
            """
        ).fetchall()
        paid_by_user_id = {r["owner_id"]: (r["total"] or 0.0) for r in rows}
        return jsonify(build_summary(users, paid_by_user_id))
    finally:
        conn.close()


# ---------- Imágenes subidas (para revisar el ticket original) ----------

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    database.init_db()
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
