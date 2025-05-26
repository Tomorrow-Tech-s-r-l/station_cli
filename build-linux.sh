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
docker build --platform linux/arm64 -t station-cli-builder -f Dockerfile.build.linux .

# Run the container and copy the executable
echo "Building and extracting executable..."
CONTAINER_ID=$(docker create station-cli-builder)
docker cp ${CONTAINER_ID}:/app/executables/station-cli-linux-arm64 ./executables/
docker rm ${CONTAINER_ID}

# Check if build was successful
if [ -f "executables/station-cli-linux-arm64" ]; then
    echo "Build successful! Executable created at: executables/station-cli-linux-arm64"
    # Show executable info
    ls -l executables/station-cli-linux-arm64
    file executables/station-cli-linux-arm64
else
    echo "Build failed! Executable not found."
    exit 1
fi 