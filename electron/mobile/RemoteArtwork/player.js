(() => {
  'use strict';
  const root = document.documentElement;
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const playButton = document.querySelector('[data-play]');
  const replayButton = document.querySelector('[data-replay]');
  const stepButtons = [...document.querySelectorAll('[data-step]')];
  const announcement = document.querySelector('[data-announcement]');
  const animations = document.getAnimations().filter((animation) =>
    animation.effect?.target?.classList.contains('motion'),
  );
  let pausedByUser = false;
  let active = true;
  let visible = true;
  let hostStep = null;
  let selectedStep = null;
  let reducedByHost = false;

  function seek(step) {
    for (const animation of animations) animation.currentTime = step * 4000 + 1600;
  }

  function renderPlayback() {
    const reduced = preference.matches || reducedByHost;
    const canPlay = active && visible && !document.hidden && !pausedByUser && !reduced && hostStep === null;
    for (const animation of animations) {
      if (canPlay) animation.play();
      else animation.pause();
    }
    root.dataset.playing = String(canPlay);
    playButton.disabled = reduced || hostStep !== null;
    playButton.textContent = reduced ? 'Still guide' : hostStep !== null ? 'Illustration' : pausedByUser ? 'Play' : 'Pause';
    playButton.setAttribute('aria-label', reduced ? 'Animation disabled by Reduce Motion' : pausedByUser ? 'Play walkthrough' : 'Pause walkthrough');
    replayButton.disabled = hostStep !== null;
    for (const button of stepButtons) {
      button.setAttribute('aria-pressed', String(selectedStep === Number(button.dataset.step)));
      button.disabled = hostStep !== null;
    }
  }

  function chooseStep(step) {
    if (hostStep !== null) return;
    selectedStep = step;
    pausedByUser = true;
    seek(step);
    announcement.textContent = stepButtons[step].getAttribute('aria-label');
    renderPlayback();
  }

  function configure(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.active === 'boolean') active = value.active;
    if (typeof value.reducedMotion === 'boolean') reducedByHost = value.reducedMotion;
    if (value.step === null || (Number.isInteger(value.step) && value.step >= 0 && value.step <= 3)) {
      if (hostStep !== value.step) {
        hostStep = value.step;
        selectedStep = hostStep;
        if (hostStep !== null) seek(hostStep);
      }
    }
    renderPlayback();
  }

  playButton.addEventListener('click', () => {
    pausedByUser = !pausedByUser;
    if (!pausedByUser) selectedStep = null;
    renderPlayback();
  });
  replayButton.addEventListener('click', () => {
    pausedByUser = false;
    selectedStep = null;
    seek(0);
    announcement.textContent = 'Walkthrough restarted. Open Remote on your computer.';
    renderPlayback();
  });
  for (const button of stepButtons) {
    button.addEventListener('click', () => chooseStep(Number(button.dataset.step)));
  }
  preference.addEventListener('change', () => {
    if (preference.matches) seek(selectedStep ?? hostStep ?? 0);
    renderPlayback();
  });
  document.addEventListener('visibilitychange', renderPlayback);
  window.addEventListener('pagehide', () => {
    active = false;
    renderPlayback();
  });
  window.addEventListener('pageshow', () => {
    active = true;
    renderPlayback();
  });
  window.addEventListener('message', (event) => {
    // The embedding window can control only illustration playback, never app actions.
    if (event.source === window.parent && event.data?.type === 'droidex.remote-artwork') {
      configure(event.data);
    }
  });
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    renderPlayback();
  });
  observer.observe(document.body);
  window.DroidexRemoteArtwork = Object.freeze({ configure });
  root.dataset.ready = 'true';
  if (preference.matches) seek(0);
  renderPlayback();
})();
