#!/bin/bash

# Exit on any error
set -e

# Print commands as they are executed
set -x

# Clean up any existing containers
echo "Cleaning up any existing containers..."
docker ps -a | grep station-cli-builder | awk '{print $1}' | xargs -r docker rm -f

# Build the Docker image
echo "Building Docker image..."
docker build --platform linux/arm64 -t station-cli-builder -f Dockerfile.build .

# Run the container with volume mount
echo "Starting container..."
CONTAINER_ID=$(docker run -d \
    --platform linux/arm64 \
    -p 2222:22 \
    -v "$(pwd):/app" \
    station-cli-builder)

# Wait for SSH to be ready
echo "Waiting for SSH to be ready..."
sleep 5

# Build the executable via SSH
echo "Building executable via SSH..."
sshpass -p 'buildpass' ssh -o StrictHostKeyChecking=no -p 2222 root@localhost '
    cd /app && \
    rm -rf dist executables && \
    npm install --no-optional && \
    npm run build && \
    NODE_OPTIONS=--no-warnings npx pkg . \
        --targets node18-linux-arm64 \
        --output executables/station-cli-linux-arm \
        --no-bytecode \
        --no-native-modules \
        --public
'

# Copy the executable from container
echo "Copying executable from container..."
docker cp ${CONTAINER_ID}:/app/executables/station-cli-linux-arm ./executables/

# Stop and remove the container
echo "Cleaning up..."
docker stop ${CONTAINER_ID}
docker rm ${CONTAINER_ID}

# Check if build was successful
if [ -f "executables/station-cli-linux-arm" ]; then
    echo "Build successful! Executable created at: executables/station-cli-linux-arm"
    # Show executable info
    ls -l executables/station-cli-linux-arm
    file executables/station-cli-linux-arm
else
    echo "Build failed! Executable not found."
    exit 1
fi 