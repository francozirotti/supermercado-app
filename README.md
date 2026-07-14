# Gastos del Súper

App web para repartir los gastos del supermercado entre las 4 personas de la vivienda.

Cada uno sube la foto de su ticket, la IA (Claude Vision) lee los ítems y precios, y cada ítem tiene una casilla para marcar si va a la cuenta común o es consumo personal. El botón "Resumen" muestra cuánto ha pagado cada uno y quién le debe a quién para quedar todos parejos.

## Cómo funciona

1. **Subir ticket**: eliges de quién es el ticket (o agregas una persona nueva), sacas/subes la foto. La IA extrae los productos y precios automáticamente.
2. **Revisar ítems**: cada producto aparece con una casilla marcada por defecto (va a la cuenta común). Desmarcas lo que sea consumo personal (ej. tu champú) y no se suma al total compartido. Puedes corregir nombre/precio o añadir ítems que la IA no haya detectado bien.
3. **Tickets**: lista de todos los tickets subidos, para revisar o corregir en cualquier momento.
4. **Resumen**: muestra cuánto pagó cada uno (solo lo marcado como común), la "parte justa" (total común ÷ número de personas), y los pagos mínimos necesarios para que todos terminen habiendo puesto lo mismo.

## Instalación

Requiere Python 3.10+.

```bash
cd supermercado-app
python3 -m venv .venv
source .venv/bin/activate        # en Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Edita `.env` y pon tu API key de Anthropic (la consigues en https://console.anthropic.com/settings/keys).

## Arrancar la app

```bash
python app.py
```

Abre `http://localhost:5000` en el navegador. Para usarla desde el celular de cada uno, todos deben estar en la misma red wifi y entrar a `http://<IP-de-tu-PC>:5000` (o desplegar la app en un hosting gratuito tipo Render/Railway/Fly.io para acceder desde cualquier lado).

## Estructura del proyecto

```
supermercado-app/
├── app.py            # Rutas de la API (Flask)
├── database.py       # Conexión y creación de la base de datos SQLite
├── schema.sql        # Tablas: users, tickets, items
├── ocr.py            # Lectura de tickets con Claude Vision
├── settlement.py      # Cálculo de balances y liquidación de deudas
├── requirements.txt
├── .env.example
├── static/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── uploads/           # Fotos de tickets guardadas
└── gastos.db          # Base de datos SQLite (se crea sola al arrancar)
```

## Notas

- El OCR usa Claude Sonnet por defecto (mejor precisión leyendo tickets arrugados o mal iluminados). Si subes muchos tickets al día y quieres bajar el costo, cambia `ANTHROPIC_MODEL` en `.env` a `claude-haiku-4-5`.
- Cada llamada a la API tiene un costo pequeño por imagen procesada (unos centavos de dólar). Revisa precios actualizados en https://docs.claude.com.
- Los datos quedan en `gastos.db` (SQLite), un solo archivo. Para "resetear" el historial, basta con borrar ese archivo (se vuelve a crear vacío al arrancar).
- No hay login/contraseñas — pensada para uso doméstico en red local. Si la despliegas en internet, considera agregar autenticación básica.

