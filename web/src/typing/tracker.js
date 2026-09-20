// 打字时长/正确/错误统计上报：进入模式首次击键开始计时，
// 每 20 秒心跳 + 页面隐藏/退出模式时补报；服务端按「用户+当天」累加。
import { api } from '../api';

export function createTracker(mode) {
  let correct = 0;
  let wrong = 0;
  let seconds = 0;
  let started = false;
  let secTimer = null;
  let beatTimer = null;
  let onHide = null;

  function flush() {
    if (!seconds && !correct && !wrong) return;
    const payload = { mode, seconds, correct, wrong };
    seconds = 0; correct = 0; wrong = 0;
    api.post('/typing/progress', payload).catch(() => {});
  }
  function ensure() {
    if (started) return;
    started = true;
    secTimer = setInterval(() => { seconds++; }, 1000);
    beatTimer = setInterval(flush, 20000);
    onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
  }
  return {
    hit(ok) { ensure(); ok ? correct++ : wrong++; },
    flush,
    dispose() {
      flush();
      clearInterval(secTimer);
      clearInterval(beatTimer);
      if (onHide) document.removeEventListener('visibilitychange', onHide);
      started = false;
    },
  };
}
