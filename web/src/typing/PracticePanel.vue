<template>
  <div class="practice">
    <div v-if="!mode" class="mode-grid">
      <div class="mode-card" @click="mode = 'game'">
        <span class="icon">🎯</span>
        <h3>游戏模式</h3>
        <p>打地鼠打字 · 像素土拨鼠<br>粒子爆炸 · 木锤敲打</p>
        <span class="badge">HOT</span>
      </div>
      <div class="mode-card" @click="mode = 'poetry'">
        <span class="icon">📜</span>
        <h3>诗词模式</h3>
        <p>唐诗 · 宋词 · 蒙学经典<br>汉字拼音对照 · 逐字拼音录入</p>
        <span class="badge">经典</span>
      </div>
      <div class="mode-card" @click="mode = 'lyrics'">
        <span class="icon">🎤</span>
        <h3>歌词模式</h3>
        <p>爱国 · 儿歌 · 流行<br>简谱旋律伴奏 · 边听边打</p>
        <span class="badge">MIDI</span>
      </div>
      <div class="mode-card" @click="mode = 'piano'">
        <span class="icon">🎹</span>
        <h3>钢琴模式</h3>
        <p>炫彩钢琴 · 卡农伴奏<br>字母坠落 · 激光爆炸</p>
        <span class="badge">炫酷</span>
      </div>
      <p class="mode-tip">练习时长、打对/打错都会自动记入「打字记录」和「赚钱日历」。结算按<b>有效字数 = 打对 − 3×打错</b>（打错 1 个减 3 个），认真打别贪快哦～ 按 Esc 或左上角按钮返回。</p>
    </div>
    <template v-else>
      <div class="mode-bar">
        <button class="back" @click="mode = null">← 换个模式</button>
        <span class="hint">Esc 返回 · 直接敲键盘开始</span>
      </div>
      <div class="mode-area">
        <GameMode v-if="mode === 'game'" @back="mode = null" />
        <PinyinMode v-else-if="mode === 'poetry'" kind="poem" @back="mode = null" />
        <PinyinMode v-else-if="mode === 'lyrics'" kind="song" @back="mode = null" />
        <PianoMode v-else-if="mode === 'piano'" @back="mode = null" />
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import GameMode from './GameMode.vue';
import PinyinMode from './PinyinMode.vue';
import PianoMode from './PianoMode.vue';

const mode = ref('');
</script>

<style scoped>
.practice { display: flex; flex-direction: column; min-height: calc(100vh - 250px); }
.mode-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; max-width: 960px; }
.mode-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; padding: 24px 18px; text-align: center; transition: all .25s; position: relative; overflow: hidden; cursor: pointer; }
.mode-card:hover { transform: translateY(-4px); border-color: var(--amber); box-shadow: 0 10px 30px rgba(251, 191, 36, .12); }
.mode-card .icon { font-size: 2.6rem; margin-bottom: 10px; display: block; }
.mode-card h3 { font-size: 15px; margin-bottom: 6px; }
.mode-card p { font-size: 12px; color: var(--text3); line-height: 1.6; }
.mode-card .badge { position: absolute; top: 8px; right: 8px; background: rgba(251, 191, 36, .15); color: var(--amber); font-size: 11px; padding: 1px 8px; border-radius: 8px; }
.mode-tip { grid-column: 1 / -1; font-size: 12.5px; color: var(--text3); margin: 4px 2px 0; }
.mode-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.mode-bar .back { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 4px 14px; font-size: 13px; cursor: pointer; }
.mode-bar .back:hover { border-color: var(--accent); color: var(--accent); }
.mode-bar .hint { font-size: 12px; color: var(--text3); }
.mode-area { flex: 1; min-height: 380px; display: flex; flex-direction: column; }
.mode-area > * { flex: 1; }
</style>
