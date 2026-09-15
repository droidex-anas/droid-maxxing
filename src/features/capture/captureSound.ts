export async function playCaptureClick(): Promise<void> {
  const audio = new AudioContext();
  const timeout = setTimeout(() => {
    if (audio.state !== 'closed') void audio.close();
  }, 1000);
  try {
    await audio.resume();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(860, audio.currentTime);
    tone.frequency.exponentialRampToValueAtTime(320, audio.currentTime + 0.055);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.065, audio.currentTime + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.09);
    tone.connect(gain);
    gain.connect(audio.destination);
    await new Promise<void>((resolve) => {
      tone.onended = () => {
        resolve();
      };
      tone.start();
      tone.stop(audio.currentTime + 0.1);
    });
  } finally {
    clearTimeout(timeout);
    if (audio.state !== 'closed') await audio.close();
  }
}
