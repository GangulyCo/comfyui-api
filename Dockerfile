# Custom ComfyUI API Docker image with your models and LoRAs
ARG comfy_version=0.3.49
ARG pytorch_version=2.7.1
ARG cuda_version=12.6

# Start from the base ComfyUI image
FROM ghcr.io/saladtechnologies/comfyui-api:comfy${comfy_version}-torch${pytorch_version}-cuda${cuda_version}-runtime

# Install system dependencies for OpenGL and graphics libraries + build tools
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    libglu1-mesa \
    build-essential \
    gcc \
    g++ \
    make \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for C compiler
ENV CC=gcc
ENV CXX=g++

ENV OUTPUT_DIR=/workspace/output
ENV INPUT_DIR=/workspace/input

# Note: Models will be loaded from the mounted /workspace volume
# Your /workspace/models directory should contain:
# - checkpoints/     (main model files)
# - loras/          (LoRA files)
# - vae/            (VAE models)
# - embeddings/     (textual inversions)
# - controlnet/     (ControlNet models)
# - upscale_models/ (upscaling models)
# - etc.

# Install any additional custom nodes you need
RUN cd /opt/ComfyUI/custom_nodes && \
    git clone https://github.com/kijai/ComfyUI-KJNodes.git && \
    cd ComfyUI-KJNodes && \
    pip install -r requirements.txt

RUN cd /opt/ComfyUI/custom_nodes && \
    git clone https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git && \
    cd ComfyUI-Frame-Interpolation && \
    python install.py

RUN cd /opt/ComfyUI/custom_nodes && \
    git clone https://github.com/yolain/ComfyUI-Easy-Use.git && \
    cd ComfyUI-Easy-Use && \
    pip install -r requirements.txt

COPY extra_model_paths.yaml /opt/ComfyUI/extra_model_paths.yaml

RUN pip install triton sageattention

# Re-declare api_version ARG to ensure it's available for ADD
ARG api_version=1.0.1

# Download the comfyui-api binary
ADD https://github.com/GangulyCo/comfyui-api/releases/download/${api_version}/comfyui-api .
RUN chmod +x comfyui-api

# Set the startup command
CMD ["./comfyui-api"]
