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
    this.initSettings();

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
    this.video.addEventListener('timeupdate', () => {
      this.updateProgress();
      this.checkSegments();
    });
    this.video.addEventListener('loadedmetadata', () => {
      this.renderChapters(this.sessionData?.chapters);
    });
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

  // ===== 设置面板 =====
  sessionData: null,   // 播放会话完整数据

  initSettings() {
    // 设置按钮
    document.getElementById('btnSettings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSettings();
    });

    // 倍速按钮
    document.getElementById('btnSpeed')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSpeedPanel();
    });

    // 设置标签页切换
    document.querySelectorAll('.player-settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.player-settings-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.renderSettingsTab(tab.dataset.tab);
      });
    });

    // 倍速选项
    document.querySelectorAll('.player-speed-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const speed = parseFloat(opt.dataset.speed);
        if (this.video) this.video.playbackRate = speed;
        document.querySelectorAll('.player-speed-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const label = document.getElementById('speedLabel');
        if (label) label.textContent = speed + 'x';
        this.hideSpeedPanel();
      });
    });

    // 点击外部关闭面板
    document.getElementById('playerView')?.addEventListener('click', (e) => {
      if (!e.target.closest('.player-settings-panel') && !e.target.closest('#btnSettings')) {
        this.hideSettings();
      }
      if (!e.target.closest('.player-speed-panel') && !e.target.closest('#btnSpeed')) {
        this.hideSpeedPanel();
      }
    });

    // 跳过按钮
    document.getElementById('playerSkipBtn')?.addEventListener('click', () => this.skipSegment());
  },

  toggleSettings() {
    const panel = document.getElementById('playerSettingsPanel');
    if (panel.hidden) {
      panel.hidden = false;
      this.hideSpeedPanel();
      this.renderSettingsTab('subtitles');
      // 更新激活的标签页
      document.querySelectorAll('.player-settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelector('.player-settings-tab[data-tab="subtitles"]')?.classList.add('active');
    } else {
      panel.hidden = true;
    }
  },

  hideSettings() {
    const panel = document.getElementById('playerSettingsPanel');
    if (panel) panel.hidden = true;
  },

  toggleSpeedPanel() {
    const panel = document.getElementById('playerSpeedPanel');
    if (panel.hidden) {
      panel.hidden = false;
      this.hideSettings();
    } else {
      panel.hidden = true;
    }
  },

  hideSpeedPanel() {
    const panel = document.getElementById('playerSpeedPanel');
    if (panel) panel.hidden = true;
  },

  renderSettingsTab(tabName) {
    const content = document.getElementById('playerSettingsContent');
    if (!content) return;

    const session = this.sessionData;
    const decision = session?.decision || {};

    if (tabName === 'subtitles') {
      const subs = decision.subtitles || [];
      const subUrls = session?.subtitle_urls || [];
      let html = `
        <div class="player-settings-item" data-sub-index="-1" onclick="Player.selectSubtitle(-1)">
          <span class="item-label">关闭字幕</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
      `;
      html += subs.map((sub, i) => {
        const label = sub.title || sub.language || `字幕 ${i + 1}`;
        const badges = [];
        if (sub.is_ai) badges.push('AI');
        if (sub.is_forced) badges.push('强制');
        if (sub.kind === 'ass') badges.push('ASS');
        else if (sub.kind === 'pgs') badges.push('PGS');
        return `
          <div class="player-settings-item" data-sub-index="${i}" onclick="Player.selectSubtitle(${i})">
            <span class="item-label">${label}</span>
            <span class="item-info">${badges.join(' · ')}</span>
            <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
          </div>
        `;
      }).join('');
      if (!subs.length) html = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-size:13px">无可用字幕</div>';
      content.innerHTML = html;
    }

    else if (tabName === 'audio') {
      const tracks = decision.audio_tracks || [];
      const currentRef = decision.audio?.track_ref;
      let html = tracks.map(t => {
        const label = t.language || `音轨 ${t.ref}`;
        const info = [t.codec, t.channels ? t.channels + 'ch' : ''].filter(Boolean).join(' · ');
        return `
          <div class="player-settings-item ${t.ref === currentRef ? 'active' : ''}" onclick="Player.selectAudio('${t.ref}')">
            <span class="item-label">${label}${t.is_default ? ' (默认)' : ''}</span>
            <span class="item-info">${info}</span>
            <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
          </div>
        `;
      }).join('');
      if (!tracks.length) html = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-size:13px">无可用音轨</div>';
      content.innerHTML = html;
    }

    else if (tabName === 'quality') {
      const source = session?.source || {};
      const video = decision.video || {};
      const tier = decision.tier;
      const html = `
        <div class="player-settings-item active">
          <span class="item-label">自动（推荐）</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.06)">
          <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:8px">当前画质信息</div>
          ${source.resolution ? `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:4px">源：${source.resolution} · ${source.video_codec || ''} · ${source.hdr || ''}</div>` : ''}
          ${video.height ? `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:4px">输出：${video.height}p${video.action === 'copy' ? ' (直通)' : ' (转码)'}</div>` : ''}
          ${tier != null ? `<div style="font-size:12px;color:rgba(255,255,255,0.6)">档位：${tier}</div>` : ''}
          ${source.bit_rate ? `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px">码率：${(source.bit_rate / 1000000).toFixed(1)} Mbps</div>` : ''}
        </div>
      `;
      content.innerHTML = html;
    }

    else if (tabName === 'speed') {
      const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
      const current = this.video?.playbackRate || 1;
      content.innerHTML = speeds.map(s => `
        <div class="player-settings-item ${s === current ? 'active' : ''}" onclick="Player.setSpeed(${s})">
          <span class="item-label">${s}x${s === 1 ? ' (正常)' : ''}</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
      `).join('');
    }
  },

  selectSubtitle(index) {
    if (!this.video) return;
    // 禁用所有字幕轨
    for (let i = 0; i < this.video.textTracks.length; i++) {
      this.video.textTracks[i].mode = 'disabled';
    }
    // 启用选中轨
    if (index >= 0 && index < this.video.textTracks.length) {
      this.video.textTracks[index].mode = 'showing';
    }
    // 更新选中态
    document.querySelectorAll('#playerSettingsContent .player-settings-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.subIndex) === index);
    });
  },

  selectAudio(ref) {
    // HTML5 video 不支持动态音轨切换（多音轨文件）
    // 对于 HLS.js 可以通过 audioTracks 切换
    if (this.hls && this.hls.audioTracks) {
      const idx = this.hls.audioTracks.findIndex(t => t.id === ref || t.name === ref);
      if (idx >= 0) this.hls.audioTrack = idx;
    }
    // 更新选中态
    document.querySelectorAll('#playerSettingsContent .player-settings-item').forEach(el => {
      el.classList.remove('active');
    });
    event?.target?.closest('.player-settings-item')?.classList.add('active');
    this.hideSettings();
  },

  setSpeed(rate) {
    if (this.video) this.video.playbackRate = rate;
    const label = document.getElementById('speedLabel');
    if (label) label.textContent = rate + 'x';
    document.querySelectorAll('.player-speed-option').forEach(o => {
      o.classList.toggle('active', parseFloat(o.dataset.speed) === rate);
    });
    this.hideSettings();
    this.hideSpeedPanel();
  },

  // ===== 跳过片头/片尾 =====
  currentSegments: [],
  currentSkipIndex: -1,

  initSegments(segments) {
    this.currentSegments = segments || [];
    this.currentSkipIndex = -1;
    const btn = document.getElementById('playerSkipBtn');
    if (btn) btn.hidden = true;
  },

  checkSegments() {
    if (!this.video || !this.currentSegments.length) return;
    const curMs = this.video.currentTime * 1000;
    const btn = document.getElementById('playerSkipBtn');
    if (!btn) return;

    let showBtn = false;
    for (let i = 0; i < this.currentSegments.length; i++) {
      const seg = this.currentSegments[i];
      if (curMs >= seg.start_ms && curMs < seg.end_ms) {
        showBtn = true;
        this.currentSkipIndex = i;
        btn.textContent = seg.type === 'intro' ? '跳过片头' : seg.type === 'outro' ? '跳过片尾' : '跳过此段';
        break;
      }
    }
    btn.hidden = !showBtn;
  },

  skipSegment() {
    if (this.currentSkipIndex < 0 || !this.video) return;
    const seg = this.currentSegments[this.currentSkipIndex];
    if (seg) {
      this.video.currentTime = seg.end_ms / 1000 + 0.5;
    }
    const btn = document.getElementById('playerSkipBtn');
    if (btn) btn.hidden = true;
    this.currentSkipIndex = -1;
  },

  // ===== 章节标记 =====
  renderChapters(chapters) {
    const seek = document.getElementById('playerSeek');
    if (!seek || !chapters?.length) return;
    // 清除旧的章节标记
    seek.querySelectorAll('.player-chapter-mark').forEach(el => el.remove());
    const dur = this.video?.duration;
    if (!dur) return;
    chapters.forEach(ch => {
      const pct = (ch.start_ms / 1000 / dur) * 100;
      if (pct < 0 || pct > 100) return;
      const mark = document.createElement('div');
      mark.className = 'player-chapter-mark';
      mark.style.left = pct + '%';
      mark.title = ch.title || '';
      seek.appendChild(mark);
    });
  },

  // 打开播放器并加载流
  open(title, streamUrl, subtitles, startMs, sessionData) {
    const view = document.getElementById('playerView');
    const titleEl = document.getElementById('playerTitle');
    const loading = document.getElementById('playerLoading');
    const loadingText = document.getElementById('playerLoadingText');

    this.currentTitle = title || 'MovieClaw';
    if (titleEl) titleEl.textContent = this.currentTitle;
    if (loading) loading.hidden = false;
    if (loadingText) loadingText.textContent = '正在加载...';

    view.hidden = false;
    this.sessionData = sessionData || null;

    // 初始化片段/章节
    this.initSegments(sessionData?.segments);
    // 渲染字幕轨信息到 settings（更新可用状态）

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
