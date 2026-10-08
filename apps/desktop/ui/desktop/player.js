// MovieClaw Desktop — 内置 HTML5 播放器（HLS.js + Video）

const Player = {
  video: null,
  hls: null,
  currentTitle: '',
  hideTimer: null,
  isSeeking: false,

  init() {
    this.video = document.getElementById('playerVideo');
    if (!this.video) return;

    // 播放/暂停
    document.getElementById('btnPlayPause')?.addEventListener('click', () => this.togglePlay());
    document.getElementById('playerCenterBtn')?.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('dblclick', () => this.toggleFullscreen());

    // 进度条
    const seek = document.getElementById('playerSeek');
    if (seek) {
      seek.addEventListener('mousedown', (e) => {
        this.isSeeking = true;
        const rect = seek.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (this.video.duration) this.video.currentTime = pct * this.video.duration;
        const onMove = (e2) => {
          const rect2 = seek.getBoundingClientRect();
          const pct2 = Math.max(0, Math.min(1, (e2.clientX - rect2.left) / rect2.width));
          if (this.video.duration) this.video.currentTime = pct2 * this.video.duration;
        };
        const onUp = () => {
          this.isSeeking = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // 快进快退
    document.getElementById('btnRew')?.addEventListener('click', () => { this.video.currentTime = Math.max(0, this.video.currentTime - 10); });
    document.getElementById('btnFwd')?.addEventListener('click', () => { this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 10); });

    // 音量
    document.getElementById('btnMute')?.addEventListener('click', () => this.toggleMute());
    const volSlider = document.getElementById('volumeSlider');
    if (volSlider) {
      volSlider.addEventListener('input', () => {
        this.video.volume = parseFloat(volSlider.value);
        this.video.muted = this.video.volume === 0;
        this.updateVolumeIcon();
      });
    }

    // 全屏
    document.getElementById('btnFullscreen')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btnPip')?.addEventListener('click', () => this.togglePip());

    // 返回
    document.getElementById('playerBack')?.addEventListener('click', () => this.close());

    // 视频事件
    this.video.addEventListener('timeupdate', () => this.updateProgress());
    this.video.addEventListener('progress', () => this.updateBuffer());
    this.video.addEventListener('play', () => {
      this.showIcon('pause');
      this.hideCenterBtn();
      this.autoHideControls();
    });
    this.video.addEventListener('pause', () => {
      this.showIcon('play');
      this.showCenterBtn();
      this.showControls();
    });
    this.video.addEventListener('ended', () => {
      this.showIcon('play');
      this.showCenterBtn();
      this.showControls();
    });
    this.video.addEventListener('waiting', () => {
      const loading = document.getElementById('playerLoading');
      if (loading) loading.hidden = false;
    });
    this.video.addEventListener('playing', () => {
      const loading = document.getElementById('playerLoading');
      if (loading) loading.hidden = true;
    });
    this.video.addEventListener('error', () => {
      const text = document.getElementById('playerLoadingText');
      const loading = document.getElementById('playerLoading');
      if (text) text.textContent = '播放失败: 无法解码该视频格式';
      if (loading) loading.hidden = false;
    });

    // 鼠标移动显示控制栏
    const view = document.getElementById('playerView');
    view?.addEventListener('mousemove', () => {
      this.showControls();
      this.autoHideControls();
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('playerView')?.hidden) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); this.togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); this.video.currentTime = Math.max(0, this.video.currentTime - 5); break;
        case 'ArrowRight': e.preventDefault(); this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 5); break;
        case 'ArrowUp': e.preventDefault(); this.video.volume = Math.min(1, this.video.volume + 0.1); this.updateVolumeIcon(); break;
        case 'ArrowDown': e.preventDefault(); this.video.volume = Math.max(0, this.video.volume - 0.1); this.updateVolumeIcon(); break;
        case 'm': this.toggleMute(); break;
        case 'f': this.toggleFullscreen(); break;
        case 'Escape': if (!document.fullscreenElement) this.close(); break;
      }
    });
  },

  // 打开播放器并加载流
  open(title, streamUrl, subtitles, startMs) {
    const view = document.getElementById('playerView');
    const titleEl = document.getElementById('playerTitle');
    const loading = document.getElementById('playerLoading');
    const loadingText = document.getElementById('playerLoadingText');

    this.currentTitle = title || 'MovieClaw';
    if (titleEl) titleEl.textContent = this.currentTitle;
    if (loading) loading.hidden = false;
    if (loadingText) loadingText.textContent = '正在加载...';

    view.hidden = false;

    // 清理旧的 HLS 实例
    if (this.hls) { this.hls.destroy(); this.hls = null; }

    const isHls = streamUrl.includes('.m3u8') || streamUrl.includes('/hls');

    if (isHls && window.Hls && Hls.isSupported()) {
      this.hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });
      this.hls.loadSource(streamUrl);
      this.hls.attachMedia(this.video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (startMs) this.video.currentTime = startMs / 1000;
        this.video.play().catch(() => {});
      });
      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          if (loadingText) loadingText.textContent = '播放失败: ' + (data.details || 'HLS 流加载错误');
          if (loading) loading.hidden = false;
        }
      });
    } else {
      // MP4 / WebM 等原生格式
      this.video.src = streamUrl;
      this.video.addEventListener('loadedmetadata', () => {
        if (startMs) this.video.currentTime = startMs / 1000;
        this.video.play().catch(() => {});
      }, { once: true });
    }

    // 字幕
    if (subtitles && subtitles.length) {
      subtitles.forEach((sub, i) => {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.src = sub;
        track.srclang = 'zh';
        track.label = '字幕 ' + (i + 1);
        if (i === 0) track.default = true;
        this.video.appendChild(track);
      });
    }

    this.showControls();
    this.autoHideControls();
  },

  // 关闭播放器
  close() {
    const view = document.getElementById('playerView');
    if (view) view.hidden = true;
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.innerHTML = '';
      this.video.load();
    }
    if (document.fullscreenElement) document.exitFullscreen();
    clearTimeout(this.hideTimer);
  },

  togglePlay() {
    if (!this.video) return;
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  },

  toggleMute() {
    if (!this.video) return;
    this.video.muted = !this.video.muted;
    this.updateVolumeIcon();
    const slider = document.getElementById('volumeSlider');
    if (slider) slider.value = this.video.muted ? 0 : this.video.volume;
  },

  toggleFullscreen() {
    const view = document.getElementById('playerView');
    if (!view) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else view.requestFullscreen().catch(() => {});
  },

  togglePip() {
    if (!this.video) return;
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else this.video.requestPictureInPicture().catch(() => {});
  },

  showIcon(name) {
    const play = document.getElementById('iconPlay');
    const pause = document.getElementById('iconPause');
    if (play) play.style.display = name === 'play' ? '' : 'none';
    if (pause) pause.style.display = name === 'pause' ? '' : 'none';
    const centerBtn = document.getElementById('playerCenterBtn');
    if (centerBtn) {
      centerBtn.innerHTML = name === 'play'
        ? '<svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
        : '<svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    }
  },

  showCenterBtn() {
    const btn = document.getElementById('playerCenterBtn');
    if (btn) btn.hidden = false;
  },

  hideCenterBtn() {
    const btn = document.getElementById('playerCenterBtn');
    if (btn) btn.hidden = true;
  },

  showControls() {
    const topbar = document.getElementById('playerTopbar');
    const controls = document.getElementById('playerControls');
    if (topbar) topbar.style.opacity = '1';
    if (controls) controls.style.opacity = '1';
  },

  hideControls() {
    const topbar = document.getElementById('playerTopbar');
    const controls = document.getElementById('playerControls');
    if (topbar) topbar.style.opacity = '0';
    if (controls) controls.style.opacity = '0';
  },

  autoHideControls() {
    clearTimeout(this.hideTimer);
    if (this.video && !this.video.paused) {
      this.hideTimer = setTimeout(() => {
        this.hideControls();
        this.hideCenterBtn();
      }, 3000);
    }
  },

  updateProgress() {
    if (!this.video || this.isSeeking) return;
    const cur = this.video.currentTime || 0;
    const dur = this.video.duration || 0;
    const pct = dur ? (cur / dur) * 100 : 0;

    const fill = document.getElementById('playerSeekFill');
    const thumb = document.getElementById('playerSeekThumb');
    if (fill) fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';

    const timeEl = document.getElementById('playerTime');
    if (timeEl) timeEl.textContent = this.formatTime(cur) + ' / ' + this.formatTime(dur);
  },

  updateBuffer() {
    if (!this.video || !this.video.buffered.length) return;
    const dur = this.video.duration || 0;
    const buf = this.video.buffered.end(this.video.buffered.length - 1);
    const pct = dur ? (buf / dur) * 100 : 0;
    const bufEl = document.getElementById('playerSeekBuffer');
    if (bufEl) bufEl.style.width = pct + '%';
  },

  updateVolumeIcon() {
    const vol = document.getElementById('iconVol');
    const mute = document.getElementById('iconMute');
    const isMuted = !this.video || this.video.muted || this.video.volume === 0;
    if (vol) vol.style.display = isMuted ? 'none' : '';
    if (mute) mute.style.display = isMuted ? '' : 'none';
  },

  formatTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },
};

// DOM 加载后初始化
document.addEventListener('DOMContentLoaded', () => Player.init());
