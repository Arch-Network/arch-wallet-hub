# Arch Wallet Hub - AWS EC2 Deployment

This guide deploys the Wallet Hub application to a single EC2 instance using Docker Compose.

## Prerequisites

- AWS CLI installed and configured (`aws configure`)
- An AWS key pair for SSH access
- Docker installed locally (for testing)

## Quick Start

### 1. Create EC2 Instance

```bash
cd deploy
./deploy-ec2.sh
```

This script will:
- Create a security group with required ports (22, 80, 443, 3005)
- Launch an EC2 instance with Docker pre-installed
- Output connection instructions

### 2. Copy Project to Server

```bash
# From project root
scp -i YOUR_KEY.pem -r . ec2-user@YOUR_EC2_IP:/opt/wallet-hub/
```

### 3. SSH and Configure

```bash
ssh -i YOUR_KEY.pem ec2-user@YOUR_EC2_IP

cd /opt/wallet-hub/deploy
cp .env.example .env
nano .env  # Configure your secrets
```

**Required Environment Variables:**

| Variable | Description |
|----------|-------------|
| `DB_PASSWORD` | PostgreSQL password |
| `API_KEY` | Your Wallet Hub API key |
| `TURNKEY_API_PUBLIC_KEY` | Turnkey API public key |
| `TURNKEY_API_PRIVATE_KEY` | Turnkey API private key |
| `TURNKEY_ORGANIZATION_ID` | Turnkey organization ID |
| `VITE_API_URL` | Frontend API URL (e.g., `http://YOUR_EC2_IP/v1`) |

### 4. Deploy

```bash
docker-compose up -d --build
```

### 5. Access Application

- **Frontend:** `http://YOUR_EC2_IP`
- **API:** `http://YOUR_EC2_IP/v1`

## Architecture

```
┌─────────────────────────────────────────┐
│              EC2 Instance               │
│  ┌─────────────────────────────────┐   │
│  │    nginx (port 80)              │   │
│  │    - Serves frontend            │   │
│  │    - Proxies /v1/* to API       │   │
│  └─────────────────────────────────┘   │
│              │                          │
│  ┌───────────▼───────────────────┐     │
│  │    wallet-hub-api (3005)      │     │
│  │    - Fastify API server       │     │
│  └───────────────────────────────┘     │
│              │                          │
│  ┌───────────▼───────────────────┐     │
│  │    PostgreSQL (5432)          │     │
│  │    - Database                 │     │
│  └───────────────────────────────┘     │
└─────────────────────────────────────────┘
```

## Commands

```bash
# View logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f api

# Restart services
docker-compose restart

# Stop all services
docker-compose down

# Rebuild and restart
docker-compose up -d --build

# Run database migrations
docker-compose exec api npm run migrate
```

## Updating the Application

```bash
# Pull latest code (if using git)
cd /opt/wallet-hub
git pull

# Or copy updated files
scp -i YOUR_KEY.pem -r . ec2-user@YOUR_EC2_IP:/opt/wallet-hub/

# Rebuild and restart
cd deploy
docker-compose up -d --build
```

## Security Notes

- The default setup uses HTTP. For production, configure HTTPS with Let's Encrypt
- Restrict SSH access to your IP in the security group
- Use strong passwords for database and API keys
- Consider using AWS Secrets Manager for sensitive values

## Troubleshooting

**Container not starting:**
```bash
docker-compose logs api  # Check API logs
docker-compose logs postgres  # Check DB logs
```

**Database connection issues:**
```bash
docker-compose exec postgres psql -U wallet_hub -d wallet_hub
```

**Frontend not loading:**
```bash
docker-compose logs frontend
docker-compose exec frontend cat /etc/nginx/conf.d/default.conf
```
