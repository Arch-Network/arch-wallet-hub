#!/bin/bash
set -e

# =====================================================
# Arch Wallet Hub - EC2 Deployment Script
# =====================================================
# This script creates an EC2 instance and deploys the
# Wallet Hub application using Docker Compose.
# =====================================================

# Configuration - modify these values
INSTANCE_TYPE="t3.medium"
KEY_NAME=""  # Your AWS key pair name
REGION="us-east-1"
AMI_ID=""  # Will be auto-detected if empty (Amazon Linux 2023)
SECURITY_GROUP_NAME="wallet-hub-sg"
INSTANCE_NAME="wallet-hub-server"

echo "============================================="
echo "Arch Wallet Hub - EC2 Deployment"
echo "============================================="

# Check for required tools
command -v aws >/dev/null 2>&1 || { echo "AWS CLI required. Install: https://aws.amazon.com/cli/"; exit 1; }

# Verify AWS credentials
echo "Verifying AWS credentials..."
aws sts get-caller-identity > /dev/null || { echo "AWS credentials not configured. Run: aws configure"; exit 1; }
echo "✓ AWS credentials valid"

# Get region
if [ -z "$REGION" ]; then
    REGION=$(aws configure get region || echo "us-east-1")
fi
echo "Using region: $REGION"

# Auto-detect AMI if not set (Amazon Linux 2023)
if [ -z "$AMI_ID" ]; then
    echo "Finding latest Amazon Linux 2023 AMI..."
    AMI_ID=$(aws ec2 describe-images \
        --region $REGION \
        --owners amazon \
        --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
        --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
        --output text)
    echo "Using AMI: $AMI_ID"
fi

# Check for key pair
if [ -z "$KEY_NAME" ]; then
    echo ""
    echo "Available key pairs:"
    aws ec2 describe-key-pairs --region $REGION --query 'KeyPairs[*].KeyName' --output table
    echo ""
    read -p "Enter key pair name: " KEY_NAME
fi

# Verify key pair exists
aws ec2 describe-key-pairs --region $REGION --key-names "$KEY_NAME" > /dev/null 2>&1 || {
    echo "Key pair '$KEY_NAME' not found. Create one in AWS Console or run:"
    echo "aws ec2 create-key-pair --key-name $KEY_NAME --query 'KeyMaterial' --output text > $KEY_NAME.pem"
    exit 1
}
echo "✓ Key pair: $KEY_NAME"

# Create or get security group
echo "Setting up security group..."
SG_ID=$(aws ec2 describe-security-groups \
    --region $REGION \
    --filters "Name=group-name,Values=$SECURITY_GROUP_NAME" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || echo "None")

if [ "$SG_ID" == "None" ] || [ -z "$SG_ID" ]; then
    echo "Creating security group: $SECURITY_GROUP_NAME"
    SG_ID=$(aws ec2 create-security-group \
        --region $REGION \
        --group-name $SECURITY_GROUP_NAME \
        --description "Wallet Hub security group" \
        --query 'GroupId' \
        --output text)
    
    # Add inbound rules
    echo "Adding security group rules..."
    aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG_ID --protocol tcp --port 22 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG_ID --protocol tcp --port 80 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG_ID --protocol tcp --port 443 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG_ID --protocol tcp --port 3005 --cidr 0.0.0.0/0
fi
echo "✓ Security group: $SG_ID"

# Create user data script for instance initialization
USER_DATA=$(cat <<'USERDATA'
#!/bin/bash
set -e

# Update system
dnf update -y

# Install Docker
dnf install -y docker git
systemctl enable docker
systemctl start docker

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Add ec2-user to docker group
usermod -aG docker ec2-user

# Create app directory
mkdir -p /opt/wallet-hub
chown ec2-user:ec2-user /opt/wallet-hub

echo "Setup complete! SSH in and deploy the application."
USERDATA
)

# Launch EC2 instance
echo ""
echo "Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --region $REGION \
    --image-id $AMI_ID \
    --instance-type $INSTANCE_TYPE \
    --key-name $KEY_NAME \
    --security-group-ids $SG_ID \
    --user-data "$USER_DATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME}]" \
    --query 'Instances[0].InstanceId' \
    --output text)

echo "✓ Instance launched: $INSTANCE_ID"
echo "Waiting for instance to be running..."

aws ec2 wait instance-running --region $REGION --instance-ids $INSTANCE_ID
echo "✓ Instance is running"

# Get public IP
PUBLIC_IP=$(aws ec2 describe-instances \
    --region $REGION \
    --instance-ids $INSTANCE_ID \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)

PUBLIC_DNS=$(aws ec2 describe-instances \
    --region $REGION \
    --instance-ids $INSTANCE_ID \
    --query 'Reservations[0].Instances[0].PublicDnsName' \
    --output text)

echo ""
echo "============================================="
echo "EC2 Instance Created Successfully!"
echo "============================================="
echo "Instance ID:  $INSTANCE_ID"
echo "Public IP:    $PUBLIC_IP"
echo "Public DNS:   $PUBLIC_DNS"
echo ""
echo "Next steps:"
echo "1. Wait 2-3 minutes for instance initialization"
echo ""
echo "2. Copy your project to the server:"
echo "   scp -i $KEY_NAME.pem -r . ec2-user@$PUBLIC_IP:/opt/wallet-hub/"
echo ""
echo "3. SSH into the instance:"
echo "   ssh -i $KEY_NAME.pem ec2-user@$PUBLIC_IP"
echo ""
echo "4. Configure and deploy:"
echo "   cd /opt/wallet-hub/deploy"
echo "   cp .env.example .env"
echo "   nano .env  # Edit with your secrets"
echo "   # Update VITE_API_URL to: http://$PUBLIC_IP/v1"
echo "   docker-compose up -d --build"
echo ""
echo "5. Access the application:"
echo "   Frontend: http://$PUBLIC_IP"
echo "   API:      http://$PUBLIC_IP:3005/v1"
echo "============================================="
