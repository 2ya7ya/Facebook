      avatar.replaceChildren(image);
    }
    const like = root.querySelector('[data-reel-action="like"]');
    like.classList.toggle('is-active', Boolean(reel.likedByMe));
    if (like.querySelector('img') && window.__reelReactionIcons) like.querySelector('img').src = reel.likedByMe ? window.__reelReactionIcons.liked : window.__reelReactionIcons.outline;
    setReelCount(root, 'like', reel.likeCount);
    setReelCount(root, 'comments', reel.comments.length);
    renderReelComments(root, reel.comments);
    const commentForm = root.querySelector('.reels-comment-form');
    if (commentForm) {
      commentForm.querySelectorAll('input,button').forEach(function (control) { control.disabled = reel.allowComments === false; });
      if (reel.allowComments === false && !reel.comments.length) root.querySelector('.reels-comments-list').textContent = 'Comments are turned off for this Reel.';
    }
    video.addEventListener('loadedmetadata', function setPublishedTrim() {
      video.removeEventListener('loadedmetadata', setPublishedTrim);
      const start = Number(video.dataset.trimStart || 0);
      if (start > 0 && start < video.duration) video.currentTime = start;
    });
    video.play().catch(function () {});
  }

  async function loadLatestReel() {
    const root = document.querySelector('.app-page[data-page-content="reels"] .reels-page');
    if (!root) return;
    try {
      const data = await api('/api/reels');
      if (data.reels && data.reels[0]) showReel(root, data.reels[0]);
    } catch (error) {
      console.error(error);
    }
  }

  function fileData(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Could not read the selected file.')); };
      reader.readAsDataURL(file);
    });
  }

  function installReels() {
    const root = document.querySelector('.app-page[data-page-content="reels"] .reels-page');
    if (!root || root.dataset.persistenceReady) return;
    root.dataset.persistenceReady = 'true';
    const file = root.querySelector('#reelsFile');
    const flow = root.querySelector('#reelCreateFlow');
    const publish = flow.querySelector('#reelCreatePublish');
    const caption = flow.querySelector('#reelCreateCaption');
    const settings = flow.querySelector('#reelSettingsLayer');
    const allowComments = flow.querySelector('#reelAllowComments');
    const audienceLabel = flow.querySelector('#reelAudienceLabel');
    const commentsLabel = flow.querySelector('#reelCommentsLabel');
    const previewVideos = Array.from(flow.querySelectorAll('video'));
    const form = root.querySelector('.reels-comment-form');
    const publishedVideo = root.querySelector('#reelsVideo');
    let selectedVideo = null;
    let selectedVideoData = '';
    let videoLoadGeneration = 0;
    let editState = freshEditState();
    const editVideo = flow.querySelector('#reelEditVideo');
    const editTime = flow.querySelector('#reelEditTime');
    const editPlayButton = flow.querySelector('[data-reel-flow-action="toggle-edit-play"]');
    const timeline = flow.querySelector('.reel-timeline');
    const timelineScroll = document.createElement('div');
    const timelineContent = document.createElement('div');
    const timelineTicks = document.createElement('div');
    const timelineFilmstrip = document.createElement('div');
    const timelineAudio = document.createElement('div');
    const timelineSoundLabel = document.createElement('div');
    const timelinePlayhead = document.createElement('div');
    const timelineMuteRail = document.createElement('div');
    const timelineMuteButton = document.createElement('button');
    const timelineSelection = document.createElement('div');
    const trimStartHandle = document.createElement('button');
    const trimEndHandle = document.createElement('button');
    const trimDurationLabel = document.createElement('span');
    const timelineAdd = timeline.querySelector('.reel-timeline-add');
    const pixelsPerSecond = 82;
    let timelineDuration = 0;
    let timelineSyncing = false;
    let timelineBuildKey = '';
    let timelineAnimationFrame = 0;
    let timelineVideoFrameCallback = 0;
    let timelineLastTextUpdate = 0;
    let timelinePlaybackAnimation = null;
    let timelineDragging = false;
    let timelinePointerDown = false;
    let timelineSettleTimer = 0;
    let timelineSelected = false;
    let timelineStageVisible = false;
    let trimCounterFrozen = false;
    let staticCounterText = '00:00/00:00';
    let staticTrimDurationText = '0s';
    timelineScroll.className = 'reel-timeline-scroll';
    timelineContent.className = 'reel-timeline-content';
    timelineTicks.className = 'reel-timeline-ticks';
    timelineFilmstrip.className = 'reel-timeline-filmstrip';
    timelineAudio.className = 'reel-timeline-audio';
    timelineAudio.dataset.reelTool = 'sound';
    timelineSoundLabel.className = 'reel-timeline-sound-label';
    timelineSoundLabel.setAttribute('aria-hidden', 'true');
    timelineSoundLabel.innerHTML = '<span>♪&nbsp; Add sound</span>';
    timelinePlayhead.className = 'reel-timeline-playhead';
    timelineMuteRail.className = 'reel-timeline-mute-rail';
    timelineMuteButton.className = 'reel-timeline-mute';
    timelineMuteButton.type = 'button';
    timelineMuteButton.setAttribute('aria-label', 'Mute video');
    timelineMuteButton.setAttribute('aria-pressed', 'false');
    timelineMuteButton.innerHTML = '';
    function muteIconSvg(muted) {
      return muted
        ? '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 12h5l7-6v20l-7-6H5z"/><path d="M21 11l7 10M28 11l-7 10" class="mute-cross"/></svg>'
        : '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 12h5l7-6v20l-7-6H5z"/><path d="M21 11c2 2 2 8 0 10M24 8c5 5 5 11 0 16" class="sound-waves"/></svg>';
    }
    timelineSelection.className = 'reel-timeline-selection';
    trimStartHandle.className = 'reel-trim-handle reel-trim-start';
    trimEndHandle.className = 'reel-trim-handle reel-trim-end';
    trimStartHandle.type = trimEndHandle.type = 'button';
    trimStartHandle.setAttribute('aria-label', 'Trim video start');
    trimEndHandle.setAttribute('aria-label', 'Trim video end');
    trimStartHandle.textContent = '‹';
    trimEndHandle.textContent = '›';
    trimDurationLabel.className = 'reel-trim-duration';
    timelineSelection.append(trimStartHandle, trimEndHandle);
    timelineMuteRail.appendChild(timelineMuteButton);
    timelineContent.append(timelineTicks, timelineFilmstrip, timelineAudio, timelineSelection, timelineMuteRail);
    timelineScroll.appendChild(timelineContent);
    timeline.replaceChildren(timelineScroll, timelinePlayhead, timelineSoundLabel, trimDurationLabel);
    if (timelineAdd) timeline.appendChild(timelineAdd);
    timelineMuteRail.hidden = true;
    function syncTimelineMuteButton() {
      // The audio row is visual only; keep the single playhead-anchored label.
      if (timelineAudio.textContent) timelineAudio.textContent = '';
      timeline.querySelectorAll('.reel-timeline-sound-label').forEach(function (label, index) {
        if (index > 0) label.remove();
      });
      const muted = Boolean(editVideo.muted);
      timelineMuteButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
      timelineMuteButton.setAttribute('aria-label', muted ? 'Unmute video' : 'Mute video');
      timelineMuteButton.innerHTML = muteIconSvg(muted);
    }
    ['pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(function (type) {
      timelineMuteButton.addEventListener(type, function (event) {
        event.stopPropagation();
      }, { passive: type.startsWith('touch') });
    });
    timelineMuteButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      const stayedPaused = editVideo.paused;
      editVideo.muted = !editVideo.muted;
      if (stayedPaused && !editVideo.paused) editVideo.pause();
      syncTimelineMuteButton();
    });
    syncTimelineMuteButton();
    const effectOrder = ['none', 'warm', 'cool', 'mono', 'vivid'];
    const stickers = ['', '✨', '❤️', '🔥', '😊'];
    const effectFilters = { none: '', warm: 'sepia(.22) hue-rotate(-8deg)', cool: 'hue-rotate(18deg) saturate(.9)', mono: 'grayscale(1)', vivid: 'saturate(1.45) contrast(1.08)' };
    const toolPanel = document.createElement('section');
    toolPanel.className = 'reel-tool-panel';
    toolPanel.setAttribute('aria-hidden', 'true');
    flow.appendChild(toolPanel);
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'reel-video-loading';
    loadingIndicator.innerHTML = '<span></span><strong>Loading video…</strong>';
    flow.appendChild(loadingIndicator);
    function freshEditState() {
      return { trimStart: 0, trimEnd: 0, brightness: 1, contrast: 1, saturation: 1, effect: 'none', text: '', sticker: '', captions: false, overlay: false, fit: 'contain' };
    }
    function ensureUserOverlay(video) {
      const panel = video.closest('[data-reel-create-stage]');
      let overlay = panel.querySelector('.reel-user-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'reel-user-overlay';
        panel.appendChild(overlay);
      }
      overlay.classList.toggle('has-vignette', editState.overlay);
      overlay.replaceChildren();
      if (editState.text) {
        const text = document.createElement('span');
        text.className = 'reel-overlay-text';
        text.textContent = editState.text;
        overlay.appendChild(text);
      }
      if (editState.sticker) {
        const sticker = document.createElement('span');
        sticker.className = 'reel-overlay-sticker';
        sticker.textContent = editState.sticker;
        overlay.appendChild(sticker);
      }
      if (editState.captions) {
        const captions = document.createElement('span');
        captions.className = 'reel-overlay-captions';
        captions.textContent = caption.value.trim() || 'Captions enabled';
        overlay.appendChild(captions);
      }
    }
    function applyPreviewEdits() {
      const filter = 'brightness(' + editState.brightness + ') contrast(' + editState.contrast + ') saturate(' + editState.saturation + ') ' + (effectFilters[editState.effect] || '');
      previewVideos.forEach(function (video) {
        video.style.filter = filter;
        video.style.objectFit = editState.fit;
        ensureUserOverlay(video);
      });
    }
    function closeToolPanel() {
      toolPanel.classList.remove('is-open');
      toolPanel.setAttribute('aria-hidden', 'true');
    }
    function openToolPanel(title, body) {
      toolPanel.innerHTML = '<header><strong></strong><button type="button" aria-label="Close">×</button></header><div class="reel-tool-panel-body"></div>';
      toolPanel.querySelector('strong').textContent = title;
      toolPanel.querySelector('.reel-tool-panel-body').appendChild(body);
      toolPanel.classList.add('is-open');
      toolPanel.setAttribute('aria-hidden', 'false');
      toolPanel.querySelector('button').addEventListener('click', closeToolPanel);
    }
    function rangeControl(label, key, min, max, step) {
      const row = document.createElement('label');
      row.className = 'reel-tool-range';
      const name = document.createElement('span');
      const output = document.createElement('output');
      const input = document.createElement('input');
      name.textContent = label;
      output.textContent = editState[key];
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = editState[key];
      input.addEventListener('input', function () { editState[key] = Number(input.value); output.textContent = input.value; applyPreviewEdits(); });
      row.append(name, output, input);
      return row;
    }
    function previewTime(value) {
      value = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
    }
    function activeTrimBounds() {
      const start = Math.min(timelineDuration, Math.max(0, Number(editState.trimStart) || 0));
      const requestedEnd = Number(editState.trimEnd);
      const end = requestedEnd > start ? Math.min(timelineDuration, requestedEnd) : timelineDuration;
      return { start: start, end: end };
    }
    function updateEditTimeDisplay() {
      // This counter is intentionally static. Playback and trimming must never
      // change either its position or its displayed value.
      editTime.textContent = staticCounterText;
    }
    function updateTrimSelection() {
      if (!timelineDuration) return;
      const start = Math.min(timelineDuration, Math.max(0, Number(editState.trimStart) || 0));
      const end = Math.min(timelineDuration, Math.max(start + .1, Number(editState.trimEnd) || timelineDuration));
      editState.trimStart = start;
      editState.trimEnd = end;
      timelineTicks.querySelectorAll('span[data-timeline-second]').forEach(function (tick) {
        const sourceSecond = Number(tick.dataset.timelineSecond);
        const outsideKeptRange = sourceSecond < start || sourceSecond > end;
        tick.hidden = outsideKeptRange;
        if (!outsideKeptRange) tick.textContent = previewTime(sourceSecond - start);
      });
      const trimLeftPx = start * pixelsPerSecond;
      timelineSelection.style.left = trimLeftPx + 'px';
      timelineSelection.style.width = Math.max(2, (end - start) * pixelsPerSecond) + 'px';
      // Keep the mute button immediately before the trimmed video strip. Because
      // it lives inside timelineContent, it follows timeline dragging; because
      // its left value follows trimStart, it also follows the left trim handle.
      timelineMuteRail.style.left = (trimLeftPx - 50) + 'px';
      // Keep the seconds badge fixed. Its value is captured once when the
      // source video loads and is never recalculated from trim bounds.
      trimDurationLabel.textContent = staticTrimDurationText;
      const hiddenRight = Math.max(0, (timelineDuration - end) * pixelsPerSecond);
      const hiddenLeft = Math.max(0, start * pixelsPerSecond);
      const clip = 'inset(0 ' + hiddenRight + 'px 0 ' + hiddenLeft + 'px)';
      timelineFilmstrip.style.clipPath = clip;
      // The Add sound row keeps its full original length and is never clipped
      // when the video itself is trimmed.
      timelineAudio.style.clipPath = 'none';
      timelineSelection.classList.toggle('is-active', timelineSelected);
      trimDurationLabel.classList.toggle('is-active', timelineSelected);
    }
    function setTimelineSelected(selected) {
      timelineSelected = Boolean(selected);
      timeline.classList.toggle('is-selected', timelineSelected);
      flow.classList.toggle('is-timeline-selected', timelineSelected);
      editTime.setAttribute('aria-hidden', 'false');
      updateTrimSelection();
    }
    function installTrimHandle(handle, edge) {
      handle.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        setTimelineSelected(true);
        editVideo.pause();
        trimCounterFrozen = true;
        timelineDragging = true;
        timelinePointerDown = true;
        cancelTimelineFollow();
        renderTimelineAt(editVideo.currentTime);
        const startX = event.clientX;
        const initialStart = editState.trimStart;
        const initialEnd = editState.trimEnd || timelineDuration;
        function move(moveEvent) {
          moveEvent.preventDefault();
          const delta = (moveEvent.clientX - startX) / pixelsPerSecond;
          if (edge === 'start') editState.trimStart = Math.min(initialEnd - .1, Math.max(0, initialStart + delta));
          else editState.trimEnd = Math.max(initialStart + .1, Math.min(timelineDuration, initialEnd + delta));
          if (editVideo.currentTime < editState.trimStart) editVideo.currentTime = editState.trimStart;
          if (editVideo.currentTime > editState.trimEnd) editVideo.currentTime = editState.trimEnd;
          updateTrimSelection();
        }
        function finish() {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          timelinePointerDown = false;
          trimCounterFrozen = false;
          editVideo.currentTime = editState.trimStart;
          renderTimelineAt(editState.trimStart);
          updateEditTimeDisplay(editState.trimStart);
          scheduleTimelineDragFinish();
        }
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', finish, { once: true });
        window.addEventListener('pointercancel', finish, { once: true });
      }, { passive: false });
    }
    installTrimHandle(trimStartHandle, 'start');
    installTrimHandle(trimEndHandle, 'end');
    function isInsideVisibleTimeline(clientX, clientY) {
      const viewportRect = timeline.getBoundingClientRect();
      const ticksRect = timelineTicks.getBoundingClientRect();
      const filmstripRect = timelineFilmstrip.getBoundingClientRect();
      const audioRect = timelineAudio.getBoundingClientRect();
      const left = Math.max(viewportRect.left, Math.min(filmstripRect.left, audioRect.left));
      const right = Math.min(viewportRect.right, Math.max(filmstripRect.right, audioRect.right));
      const top = Math.max(viewportRect.top, Math.min(ticksRect.top, filmstripRect.top));
      const bottom = Math.min(viewportRect.bottom, Math.max(filmstripRect.bottom, audioRect.bottom));
      return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
    }
    document.addEventListener('pointerdown', function (event) {
      if (!timelineSelected) return;
      if (event.target.closest('.reel-timeline-audio,.reel-timeline-sound-label')) {
        setTimelineSelected(false);
        return;
      }
      // Playing or pausing the preview must not close the active trim controls.
      if (event.target.closest('[data-reel-flow-action="toggle-edit-play"]')) return;
      if (event.target.closest('.reel-timeline-mute')) return;
      if (event.target.closest('.reel-trim-handle')) return;
      // The timeline surface handles its own tap-vs-drag decision. A drag on
      // the black area must remain available even though a plain tap closes it.
      if (event.target.closest('.reel-timeline-scroll')) return;
      if (isInsideVisibleTimeline(event.clientX, event.clientY)) return;
      setTimelineSelected(false);
    }, true);
    function seekThumbnailVideo(video, time) {
      return new Promise(function (resolve) {
        if (Math.abs(video.currentTime - time) < .02) return resolve();
        let finished = false;
        function done() {
          if (finished) return;
          finished = true;
          video.removeEventListener('seeked', done);
          resolve();
        }
        video.addEventListener('seeked', done, { once: true });
        try { video.currentTime = time; } catch (error) { done(); }
        window.setTimeout(done, 900);
      });
    }
    async function buildTimelineThumbnails(duration) {
      if (!selectedVideoData || !Number.isFinite(duration) || duration <= 0) return;
      const buildKey = String(videoLoadGeneration) + ':' + duration;
      if (timelineBuildKey === buildKey) return;
      timelineBuildKey = buildKey;
      timelineDuration = duration;
      const width = Math.max(1, duration * pixelsPerSecond);
      timelineContent.style.width = width + 'px';
      timelineTicks.replaceChildren();
      timelineFilmstrip.replaceChildren();
      for (let second = 0; second <= Math.ceil(duration); second += 1) {
        const tick = document.createElement('span');
        tick.style.left = (second * pixelsPerSecond) + 'px';
        tick.dataset.timelineSecond = String(second);
        tick.textContent = previewTime(second);
        timelineTicks.appendChild(tick);
      }
      updateTrimSelection();
      const frameCount = Math.min(120, Math.max(1, Math.ceil(duration)));
      const frameDuration = 1;
      const source = document.createElement('video');
      source.className = 'reel-thumbnail-source';
      source.muted = true;
      source.playsInline = true;
      source.preload = 'auto';
      source.src = selectedVideoData;
      flow.querySelector('[data-reel-create-stage="edit"]').appendChild(source);
      await new Promise(function (resolve, reject) {
        if (source.readyState >= 2) return resolve();
        source.addEventListener('loadeddata', resolve, { once: true });
        source.addEventListener('error', reject, { once: true });
        source.load();
      }).catch(function () {});
      if (timelineBuildKey !== buildKey || !source.videoWidth || !source.videoHeight) {
        source.remove();
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = 112;
      canvas.height = 64;
      const context = canvas.getContext('2d');
      for (let index = 0; index < frameCount; index += 1) {
        if (timelineBuildKey !== buildKey) break;
        const time = Math.min(duration - .01, index + .5);
        await seekThumbnailVideo(source, Math.max(0, time));
        const sourceRatio = source.videoWidth / source.videoHeight;
        const targetRatio = canvas.width / canvas.height;
        let sx = 0, sy = 0, sw = source.videoWidth, sh = source.videoHeight;
        if (sourceRatio > targetRatio) { sw = source.videoHeight * targetRatio; sx = (source.videoWidth - sw) / 2; }
        else { sh = source.videoWidth / targetRatio; sy = (source.videoHeight - sh) / 2; }
        context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        const image = document.createElement('img');
        image.alt = '';
        image.src = canvas.toDataURL('image/jpeg', .72);
        image.style.left = (index * pixelsPerSecond) + 'px';
        image.style.width = Math.max(1, Math.min(1, duration - index) * pixelsPerSecond + 1) + 'px';
        timelineFilmstrip.appendChild(image);
      }
      source.remove();
    }
    function setupTimeline(duration) {
      timelineDuration = Number.isFinite(duration) ? duration : 0;
      if (!editState.trimEnd || editState.trimEnd > timelineDuration) editState.trimEnd = timelineDuration;
      trimCounterFrozen = false;
      staticCounterText = '00:00/' + previewTime(timelineDuration);
      staticTrimDurationText = timelineDuration.toFixed(1).replace(/\.0$/, '') + 's';
      updateEditTimeDisplay();
      updateTrimSelection();
      buildTimelineThumbnails(timelineDuration).catch(function (error) { console.error(error); });
    }
    editVideo.addEventListener('loadedmetadata', function () { setupTimeline(editVideo.duration); });
    function syncTimelineMuteVisibility(time) {
      const relativeTime = Math.max(0, (Number(time) || 0) - (editState.trimStart || 0));
      timelineMuteRail.hidden = !timelineStageVisible || relativeTime >= 2;
    }
    function renderTimelineAt(time) {
      const offset = Math.max(0, Math.min(timelineDuration, Number(time) || 0)) * pixelsPerSecond;
      timelineContent.style.transform = 'translate3d(' + (-offset) + 'px,0,0)';
      syncTimelineMuteVisibility(time);
    }
    function syncEditPlayback(forceText) {
      if (!timelineDragging && editState.trimEnd > editState.trimStart && editState.trimEnd < timelineDuration && editVideo.currentTime >= editState.trimEnd) {
        editVideo.currentTime = Math.max(editState.trimStart, editState.trimEnd - .01);
        editVideo.pause();
      }
      const now = performance.now();
      syncTimelineMuteVisibility(editVideo.currentTime);
      if (forceText || now - timelineLastTextUpdate > 90) {
        timelineLastTextUpdate = now;
        updateEditTimeDisplay(editVideo.currentTime);
      }
      if (timelineDragging || editVideo.paused) renderTimelineAt(editVideo.currentTime);
    }
    function cancelTimelineFollow() {
      cancelAnimationFrame(timelineAnimationFrame);
      if (timelineVideoFrameCallback && typeof editVideo.cancelVideoFrameCallback === 'function') editVideo.cancelVideoFrameCallback(timelineVideoFrameCallback);
      if (timelinePlaybackAnimation) timelinePlaybackAnimation.cancel();
      timelineAnimationFrame = 0;
      timelineVideoFrameCallback = 0;
      timelinePlaybackAnimation = null;
    }
    function scheduleTimelineFollow() {
      if (editVideo.paused) return;
      cancelTimelineFollow();
      const start = Math.max(editState.trimStart || 0, editVideo.currentTime || 0);
      const end = editState.trimEnd > start ? editState.trimEnd : timelineDuration;
      renderTimelineAt(start);
      if (end <= start || typeof timelineContent.animate !== 'function') {
        timelineAnimationFrame = requestAnimationFrame(function fallbackFollow() {
          if (editVideo.paused || timelineDragging) return;
          renderTimelineAt(editVideo.currentTime);
          timelineAnimationFrame = requestAnimationFrame(fallbackFollow);
        });
        return;
      }
      timelinePlaybackAnimation = timelineContent.animate([
        { transform: 'translate3d(' + (-(start * pixelsPerSecond)) + 'px,0,0)' },
        { transform: 'translate3d(' + (-(end * pixelsPerSecond)) + 'px,0,0)' }
      ], { duration: ((end - start) * 1000) / Math.max(.1, Math.abs(editVideo.playbackRate || 1)), easing: 'linear', fill: 'forwards' });
    }
    editVideo.addEventListener('timeupdate', function () { syncEditPlayback(editVideo.paused); });
    editVideo.addEventListener('play', function () {
      if (editPlayButton) editPlayButton.textContent = '❚❚';
      cancelTimelineFollow();
      scheduleTimelineFollow();
    });
    editVideo.addEventListener('pause', function () {
      if (editPlayButton) editPlayButton.textContent = '▶';
      cancelTimelineFollow();
      syncEditPlayback(true);
    });
    function finishTimelineDrag() {
