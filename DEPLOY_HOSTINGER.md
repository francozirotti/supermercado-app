# Desplegar "Gastos del Súper" en tu VPS de Hostinger (con auto-deploy desde GitHub)

Tu caso: VPS Ubuntu/Debian sin panel, ya tiene otra web/app corriendo, entras por IP directamente (sin dominio). Cada `git push` a la rama `main` actualiza la app sola — no vuelves a tocar el VPS para actualizar.

El repo de GitHub puede ser **público** sin ningún riesgo: tu `.env` con la API key está en `.gitignore`, nunca se sube al repo. Si prefieres privado igual funciona, solo agrega un paso extra que se indica más abajo.

---

## Parte 1 — Preparar el VPS (una sola vez)

### 1. Conectarte por SSH

```bash
ssh root@TU_IP_DEL_VPS
```

### 2. Ver qué puertos están libres

```bash
sudo ss -tulpn | grep LISTEN
```

Vamos a usar el puerto **8080** para esta app (no toca nada de tu otro sitio, que seguirá en 80/443). Si `8080` ya aparece ocupado, usa `8090` y ajústalo en el resto de la guía.

### 3. Instalar lo necesario

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git
```

### 4. Crear un usuario dedicado para el despliegue (recomendado)

Así, si la clave que usa GitHub Actions se filtrara alguna vez, el daño está limitado a esta app — no tiene acceso root ni a tu otro sitio.

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo mkdir -p /opt/supermercado-app
sudo chown deploy:deploy /opt/supermercado-app
```

Dale permiso para reiniciar SOLO el servicio de esta app, sin contraseña, sin más privilegios:

```bash
echo "deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart supermercado" | sudo tee /etc/sudoers.d/deploy-supermercado
sudo chmod 440 /etc/sudoers.d/deploy-supermercado
```

### 5. Clonar el repo (como usuario deploy)

Primero sube tu carpeta `supermercado-app` a un repo nuevo en GitHub (si no sabes cómo, dímelo y te guío paso a paso — básicamente: crear repo vacío en github.com, y desde tu Mac en la carpeta del proyecto: `git init`, `git add .`, `git commit -m "primera versión"`, `git remote add origin <URL-del-repo>`, `git push -u origin main`).

Luego, en el VPS:

```bash
sudo -u deploy git clone https://github.com/TU_USUARIO/supermercado-app.git /opt/supermercado-app
```

> Si el repo es **privado**, este clone pedirá autenticación. Lo más simple: genera un token de acceso personal (fine-grained, solo lectura de ese repo) en GitHub → Settings → Developer settings → Personal access tokens, y úsalo como contraseña cuando git lo pida. O usa una deploy key SSH si prefieres — avísame y te dejo esos pasos también.

### 6. Entorno virtual, dependencias y API key

```bash
sudo -u deploy bash -c '
cd /opt/supermercado-app
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install gunicorn
cp .env.example .env
'
sudo -u deploy nano /opt/supermercado-app/.env
```

Pega tu `ANTHROPIC_API_KEY` real ahí. Guarda con `Ctrl+O`, `Enter`, sal con `Ctrl+X`.

### 7. Servicio systemd

```bash
sudo nano /etc/systemd/system/supermercado.service
```

```ini
[Unit]
Description=Gastos del Super - Flask app
After=network.target

[Service]
User=deploy
WorkingDirectory=/opt/supermercado-app
EnvironmentFile=/opt/supermercado-app/.env
ExecStart=/opt/supermercado-app/.venv/bin/gunicorn -w 2 -b 0.0.0.0:8080 app:app
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable supermercado
sudo systemctl start supermercado
sudo systemctl status supermercado   # debe decir "active (running)"
```

### 8. Abrir el puerto 8080

```bash
sudo ufw status
# si dice "active":
sudo ufw allow 8080/tcp
```

Y revisa también hPanel → VPS → tu servidor → pestaña **Firewall**: si tienes reglas ahí, agrega una para permitir entrada TCP en el puerto 8080.

### 9. Probar

```
http://TU_IP_DEL_VPS:8080
```

---

## Parte 2 — Conectar GitHub Actions (auto-deploy)

### 1. Generar una clave SSH exclusiva para el despliegue automático

Desde tu Mac (no la confundas con tu clave SSH personal — esta es solo para que GitHub entre al VPS):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gh_actions_deploy -N ""
```

Esto crea dos archivos: `gh_actions_deploy` (privada) y `gh_actions_deploy.pub` (pública).

### 2. Autorizar la clave pública en el VPS

```bash
cat ~/.ssh/gh_actions_deploy.pub
```

Copia esa línea. En el VPS:

```bash
sudo mkdir -p /home/deploy/.ssh
sudo nano /home/deploy/.ssh/authorized_keys
```

Pega la línea, guarda, y luego:

```bash
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

### 3. Guardar los datos como "secrets" en GitHub

En tu repo → **Settings → Secrets and variables → Actions → New repository secret**, crea estos cuatro:

| Nombre | Valor |
|---|---|
| `VPS_HOST` | La IP de tu VPS |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | Todo el contenido del archivo `~/.ssh/gh_actions_deploy` (la privada) — desde `-----BEGIN...` hasta `-----END...` |
| `VPS_PORT` | `22` (o el puerto SSH que uses si lo cambiaste) |

Para ver el contenido de la clave privada: `cat ~/.ssh/gh_actions_deploy` en tu Mac.

### 4. El workflow ya está listo en el proyecto

El archivo `.github/workflows/deploy.yml` (ya incluido en tu carpeta `supermercado-app`) hace exactamente esto en cada push a `main`:

```yaml
name: Deploy a VPS Hostinger

on:
  push:
    branches: [ main ]
  workflow_dispatch: {}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Desplegar por SSH en el VPS
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          port: ${{ secrets.VPS_PORT || 22 }}
          script: |
            set -e
            cd /opt/supermercado-app
            git pull origin main
            source .venv/bin/activate
            pip install -r requirements.txt
            sudo systemctl restart supermercado
            echo "Despliegue completado: $(date)"
```

Solo asegúrate de que este archivo quede subido dentro de tu repo (ya está en la carpeta del proyecto que tienes).

### 5. Probar el auto-deploy

Haz cualquier cambio pequeño, y desde tu Mac:

```bash
git add .
git commit -m "prueba de auto-deploy"
git push
```

Ve a tu repo en GitHub → pestaña **Actions**. Deberías ver el workflow corriendo (círculo amarillo → luego check verde). Cuando termine, refresca `http://TU_IP_DEL_VPS:8080` y el cambio ya debería estar ahí.

Si sale en rojo (falló), click en el run para ver el log del error — casi siempre es un secret mal copiado o el puerto SSH equivocado.

---

## De ahora en adelante

Tu flujo de trabajo para actualizar la app queda así:

```bash
# editas el código en tu Mac
git add .
git commit -m "lo que cambiaste"
git push
```

Y en un minuto está actualizado en el VPS. No vuelves a entrar por SSH salvo que algo falle.

## Nota de seguridad

Sin dominio ni Nginx, esta ruta queda por HTTP simple (sin HTTPS) — aceptable para uso entre las 4 personas de la vivienda, pero las fotos de los tickets viajan sin cifrar por esa IP:puerto. Si más adelante quieres HTTPS, se puede sumar un subdominio + Nginx + Certbot como capa aparte, sin tocar nada de esto.

## Ver logs si algo falla

```bash
sudo journalctl -u supermercado -f
```
