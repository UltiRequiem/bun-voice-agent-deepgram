class VoiceAgent {
  constructor() {
    this.socket = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.processor = null;
    this.isConnected = false;
    this.audioQueue = [];
    this.isPlaying = false;
    this.selectedDeviceId = null;

    // UI elements
    this.statusIndicator = document.getElementById("status-indicator");
    this.statusText = document.getElementById("status-text");
    this.connectBtn = document.getElementById("connect-btn");
    this.disconnectBtn = document.getElementById("disconnect-btn");
    this.deviceSelect = document.getElementById("device-select");
    this.chatMessages = document.getElementById("chat-messages");
    this.volumeBar = document.getElementById("volume-bar");
    this.typingIndicator = document.getElementById("typing-indicator");

    this.initializeEventListeners();
    this.loadAudioDevices();
  }

  initializeEventListeners() {
    this.connectBtn.addEventListener("click", () => this.connect());
    this.disconnectBtn.addEventListener("click", () => this.disconnect());
    this.deviceSelect.addEventListener("change", (e) => {
      this.selectedDeviceId = e.target.value;
    });

    // Clean up when the page is closed
    window.addEventListener("beforeunload", () => this.cleanup());
  }

  async loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(
        (device) => device.kind === "audioinput"
      );

      this.deviceSelect.innerHTML =
        '<option value="">Default Microphone</option>';
      for (const device of audioInputs) {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent =
          device.label || `Microphone ${device.deviceId.slice(0, 8)}...`;
        this.deviceSelect.appendChild(option);
      }
    } catch (error) {
      console.error("Error loading audio devices:", error);
    }
  }

  updateStatus(status, message) {
    const statusDot = this.statusIndicator.querySelector(".status-dot");
    statusDot.className = `status-dot ${status}`;
    this.statusText.textContent = message;
  }

  addMessage(type, content, timestamp = new Date()) {
    const messageDiv = document.createElement("div");
    messageDiv.className = `message ${type}`;

    messageDiv.innerHTML = `
            <div class="message-bubble">
                ${content}
                <span class="message-time">${timestamp.toLocaleTimeString()}</span>
            </div>
        `;

    this.chatMessages.appendChild(messageDiv);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  showTypingIndicator() {
    this.typingIndicator.style.display = "block";
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  hideTypingIndicator() {
    this.typingIndicator.style.display = "none";
  }

  async connect() {
    try {
      this.updateStatus("connecting", "Connecting...");
      this.connectBtn.disabled = true;

      // Create audio context early
      this.audioContext = new AudioContext({
        sampleRate: 24000,
      });

      // Get microphone permission with specific constraints
      const constraints = {
        audio: {
          deviceId: this.selectedDeviceId
            ? { exact: this.selectedDeviceId }
            : undefined,
          channelCount: 1,
          sampleRate: 24000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          latency: 0,
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: true,
        },
      };

      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Connect to WebSocket server
      this.socket = new WebSocket("ws://localhost:3000");

      this.socket.onopen = () => {
        this.isConnected = true;
        this.updateStatus("connected", "Connected - Voice Agent Ready");
        this.connectBtn.disabled = true;
        this.disconnectBtn.disabled = false;
        this.startStreaming();
        this.addMessage("agent", "Voice agent connected. Start speaking!");
      };

      this.socket.onmessage = async (event) => {
        if (event.data instanceof Blob) {
          try {
            this.hideTypingIndicator();
            const arrayBuffer = await event.data.arrayBuffer();
            const audioData = new Int16Array(arrayBuffer);
            this.audioQueue.push(audioData);

            if (!this.isPlaying) {
              this.playNextInQueue();
            }
          } catch (error) {
            console.error("Error processing audio response:", error);
          }
        } else {
          // Handle text messages (transcripts, etc.)
          try {
            const data = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
          } catch (error) {
            console.error("Error parsing WebSocket message:", error);
          }
        }
      };

      this.socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        this.updateStatus("disconnected", "Connection Error");
        this.connectBtn.disabled = false;
        this.disconnectBtn.disabled = true;
      };

      this.socket.onclose = () => {
        this.isConnected = false;
        this.updateStatus("disconnected", "Disconnected");
        this.connectBtn.disabled = false;
        this.disconnectBtn.disabled = true;
        this.stopStreaming();
      };
    } catch (error) {
      console.error("Error connecting:", error);
      this.updateStatus("disconnected", "Failed to Connect");
      this.connectBtn.disabled = false;
      this.addMessage(
        "agent",
        "Failed to connect. Please check your microphone permissions."
      );
    }
  }

  handleWebSocketMessage(data) {
    switch (data.type) {
      case "user_transcript":
        if (data.transcript?.trim()) {
          this.addMessage("user", data.transcript);
        }
        break;
      case "agent_response":
        if (data.text?.trim()) {
          this.addMessage("agent", data.text);
        }
        break;
      case "agent_thinking":
        this.showTypingIndicator();
        break;
      case "error":
        this.addMessage("agent", `Error: ${data.message}`);
        break;
    }
  }

  disconnect() {
    this.cleanup();
    this.updateStatus("disconnected", "Disconnected");
    this.connectBtn.disabled = false;
    this.disconnectBtn.disabled = true;
    this.addMessage("agent", "Voice agent disconnected.");
  }

  startStreaming() {
    if (!this.mediaStream || !this.isConnected) return;

    try {
      const source = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );
      const bufferSize = 2048;
      this.processor = this.audioContext.createScriptProcessor(
        bufferSize,
        1,
        1
      );

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      let lastSendTime = 0;
      const sendInterval = 100; // Send every 100ms
      let isCurrentlySpeaking = false;

      this.processor.onaudioprocess = (e) => {
        const now = Date.now();
        const inputData = e.inputBuffer.getChannelData(0);

        // Calculate volume for visual feedback
        const volume = this.calculateVolume(inputData);
        this.updateVolumeBar(volume);

        // Voice Activity Detection (simple threshold)
        const isSpeaking = volume > 0.01;

        if (isSpeaking && !isCurrentlySpeaking) {
          isCurrentlySpeaking = true;
          // User started speaking - could show some UI feedback
        }

        if (!isSpeaking && isCurrentlySpeaking) {
          isCurrentlySpeaking = false;
          // User stopped speaking
        }

        if (
          this.socket?.readyState === WebSocket.OPEN &&
          now - lastSendTime >= sendInterval
        ) {
          const pcmData = this.convertFloatToPcm(inputData);
          this.socket.send(pcmData.buffer);
          lastSendTime = now;
        }
      };
    } catch (error) {
      console.error("Error starting audio stream:", error);
    }
  }

  calculateVolume(audioData) {
    let sum = 0;
    for (let i = 0; i < audioData.length; i++) {
      sum += audioData[i] * audioData[i];
    }
    return Math.sqrt(sum / audioData.length);
  }

  updateVolumeBar(volume) {
    const percentage = Math.min(100, volume * 1000); // Scale up for visibility
    this.volumeBar.style.width = `${percentage}%`;
  }

  convertFloatToPcm(floatData) {
    const pcmData = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]));
      pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcmData;
  }

  async playNextInQueue() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const audioData = this.audioQueue.shift();

    try {
      // Ensure audio context is running
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      // Create buffer with correct sample rate for agent's audio (24000Hz)
      const buffer = this.audioContext.createBuffer(1, audioData.length, 24000);
      const channelData = buffer.getChannelData(0);

      // Convert Int16 to Float32 with proper scaling
      for (let i = 0; i < audioData.length; i++) {
        channelData[i] = audioData[i] / (audioData[i] >= 0 ? 0x7fff : 0x8000);
      }

      // Create and configure source
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;

      // Create a gain node for volume control
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 1.0;

      // Connect nodes
      source.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      // Handle playback completion
      source.onended = () => {
        this.playNextInQueue();
      };

      // Start playback
      source.start(0);
    } catch (error) {
      console.error("Error playing audio:", error);
      this.isPlaying = false;
      this.playNextInQueue();
    }
  }

  stopStreaming() {
    this.audioQueue = [];
    this.isPlaying = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    this.isConnected = false;
  }

  cleanup() {
    this.stopStreaming();

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.hideTypingIndicator();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.voiceAgent = new VoiceAgent();
});
