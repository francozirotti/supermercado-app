"""Lectura de tickets de supermercado usando la API de Claude (visión + PDF)."""
import base64
import io
import json
import os

from anthropic import Anthropic
from PIL import Image

# Modelo a usar para leer los tickets. Se puede sobreescribir con la variable
# de entorno ANTHROPIC_MODEL. claude-haiku-4-5 es una alternativa más barata
# si claude-sonnet-4-6 resulta caro para el volumen de tickets que subes.
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")

MAX_DIMENSION = 1600  # px, para no mandar fotos gigantes a la API
PDF_EXTENSIONS = {"pdf"}

PROMPT = """Eres un sistema de lectura de tickets (facturas/boletas) de supermercado.

Analiza el archivo adjunto (puede ser una foto o un PDF del ticket) y devuelve \
EXCLUSIVAMENTE un JSON válido, sin texto antes ni después, sin bloques de código \
markdown, con esta forma exacta:

{
  "store": "nombre del supermercado si se ve, o null",
  "date": "fecha del ticket en formato YYYY-MM-DD si se ve, o null",
  "items": [
    {"name": "nombre del producto tal como aparece (o normalizado si es una abreviatura clara)", "price": 2.35}
  ]
}

Reglas:
- "price" es el precio final de esa línea, en formato numérico decimal con punto (nunca coma, nunca símbolo de moneda).
- Incluye SOLO ítems de producto individuales comprados. No incluyas líneas de "TOTAL", "SUBTOTAL", "IVA", "cambio", "tarjeta", "efectivo", "puntos", ni descuentos generales de ticket.
- Si un producto tiene un descuento propio aplicado, usa el precio final ya con el descuento.
- Si hay cantidad mayor a 1 (ej. "2 x Manzanas 1,50"), usa el precio TOTAL de esa línea (3,00), no el precio unitario, y refleja la cantidad en el nombre si es útil (ej. "Manzanas (x2)").
- Si un precio no se lee con total claridad, igual inclúyelo con tu mejor estimación; no omitas productos.
- No inventes productos que no estén impresos en el ticket.
- Si no logras leer la fecha con certeza, devuelve "date": null en vez de adivinar.
"""


def _get_client() -> Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Falta la variable de entorno ANTHROPIC_API_KEY. "
            "Copia .env.example a .env y pon tu API key."
        )
    return Anthropic(api_key=api_key)


def _preprocess_image(image_bytes: bytes) -> tuple[bytes, str]:
    """Reduce el tamaño de la foto y la normaliza a JPEG para abaratar la llamada."""
    img = Image.open(io.BytesIO(image_bytes))
    img = img.convert("RGB")
    if max(img.size) > MAX_DIMENSION:
        img.thumbnail((MAX_DIMENSION, MAX_DIMENSION))
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue(), "image/jpeg"


def _extract_json(text: str) -> dict:
    text = text.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"No se encontró JSON en la respuesta del modelo: {text[:300]}")
    return json.loads(text[start : end + 1])


def _build_content_block(file_bytes: bytes, filename: str) -> dict:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in PDF_EXTENSIONS:
        b64_data = base64.standard_b64encode(file_bytes).decode("utf-8")
        return {
            "type": "document",
            "source": {
                "type": "base64",
                "media_type": "application/pdf",
                "data": b64_data,
            },
        }
    processed_bytes, media_type = _preprocess_image(file_bytes)
    b64_data = base64.standard_b64encode(processed_bytes).decode("utf-8")
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": b64_data,
        },
    }


def extract_items_from_file(file_bytes: bytes, filename: str) -> dict:
    """Envía la foto o PDF del ticket a Claude y devuelve
    {store, date, items:[{name, price}]}."""
    content_block = _build_content_block(file_bytes, filename)

    client = _get_client()
    message = client.messages.create(
        model=MODEL,
        max_tokens=2048,
        messages=[
            {
                "role": "user",
                "content": [content_block, {"type": "text", "text": PROMPT}],
            }
        ],
    )

    raw_text = "".join(
        block.text for block in message.content if getattr(block, "type", None) == "text"
    )
    data = _extract_json(raw_text)

    # Normaliza estructura por si el modelo omite alguna clave
    data.setdefault("store", None)
    data.setdefault("date", None)
    items = data.get("items") or []
    clean_items = []
    for item in items:
        name = str(item.get("name", "")).strip()
        try:
            price = round(float(item.get("price", 0)), 2)
        except (TypeError, ValueError):
            price = 0.0
        if name:
            clean_items.append({"name": name, "price": price})
    data["items"] = clean_items
    return data
