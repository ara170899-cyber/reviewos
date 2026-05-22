// ReviewOS · motion-bits.js
// Один модуль с готовыми анимациями поверх Motion (motion.dev). Экспонируется глобально как window.MX.
import { animate, stagger, inView } from "https://cdn.jsdelivr.net/npm/motion@12/+esm";

const MX = { animate, stagger, inView };

// ───────────────────────────────────────────────────────────────────────────
// 1. KPI counter: плавно от текущего значения к новому числу
// el — DOM-элемент с .textContent
// to — целевое число
// opts — { duration: 0.8, format: (n) => string }
MX.animateNumber = (el, to, opts = {}) => {
  if (!el) return;
  const duration = opts.duration ?? 0.8;
  const ease = opts.ease ?? [0.16, 1, 0.3, 1]; // smooth ease-out-quint
  const format = opts.format ?? ((n) => Math.round(n).toLocaleString("ru-RU"));
  const fromRaw = parseFloat(String(el.textContent || "0").replace(/[^\d.,-]/g, "").replace(",", "."));
  const from = Number.isFinite(fromRaw) ? fromRaw : 0;
  const target = Number(to) || 0;
  if (from === target) {
    el.textContent = format(target);
    return;
  }
  // Отменяем предыдущую анимацию, если осталась
  if (el.__mxNumAnim) el.__mxNumAnim.cancel?.();
  el.__mxNumAnim = animate(from, target, {
    duration,
    ease,
    onUpdate: (v) => { el.textContent = format(v); },
  });
};

// ───────────────────────────────────────────────────────────────────────────
// 2. Stagger fade-up: появление списка элементов друг за другом
MX.staggerFadeUp = (els, opts = {}) => {
  const nodes = typeof els === "string"
    ? Array.from(document.querySelectorAll(els))
    : (els?.length != null ? Array.from(els) : els ? [els] : []);
  if (!nodes.length) return;
  const dy = opts.distance ?? 12;
  const dur = opts.duration ?? 0.4;
  const step = opts.stagger ?? 0.05;
  animate(
    nodes,
    { opacity: [0, 1], transform: [`translateY(${dy}px)`, "translateY(0px)"] },
    { duration: dur, delay: stagger(step), ease: "easeOut" }
  );
};

// ───────────────────────────────────────────────────────────────────────────
// 3. Spring entry для toast/уведомлений
MX.springToast = (el) => {
  if (!el) return;
  animate(
    el,
    { opacity: [0, 1], transform: ["translateY(40px) scale(0.95)", "translateY(0) scale(1)"] },
    { type: "spring", stiffness: 320, damping: 24, mass: 0.8 }
  );
};
MX.springToastOut = (el) => {
  if (!el) return Promise.resolve();
  return animate(
    el,
    { opacity: [1, 0], transform: ["translateY(0)", "translateY(20px)"] },
    { duration: 0.2, ease: "easeIn" }
  ).finished?.catch(() => {}) || Promise.resolve();
};

// ───────────────────────────────────────────────────────────────────────────
// 4. Pulse-confirm: пульсация на кнопке при первом клике (двушаговое подтверждение)
MX.pulseConfirm = (btn) => {
  if (!btn) return;
  animate(
    btn,
    { transform: ["scale(1)", "scale(1.045)", "scale(1)"] },
    { duration: 0.55, ease: "easeOut", repeat: 1, repeatType: "loop" }
  );
};

// ───────────────────────────────────────────────────────────────────────────
// 5. Fade-in для нового сообщения (используется после AI-генерации)
MX.fadeInMessage = (el) => {
  if (!el) return;
  animate(
    el,
    { opacity: [0, 1], transform: ["translateY(8px)", "translateY(0)"] },
    { duration: 0.32, ease: "easeOut" }
  );
};

// ───────────────────────────────────────────────────────────────────────────
// 6. Skeleton helper: возвращает строку HTML для placeholder'а
// kind — 'chat' | 'card' | 'line'
MX.skeleton = (kind = "line", count = 1) => {
  const items = [];
  for (let i = 0; i < count; i++) {
    if (kind === "chat") {
      items.push(`<div class="mx-skel-row">
        <div class="mx-skel mx-skel-line" style="width:60%;height:13px"></div>
        <div class="mx-skel mx-skel-line" style="width:95%;height:11px;margin-top:6px"></div>
        <div class="mx-skel mx-skel-line" style="width:80%;height:11px;margin-top:4px"></div>
      </div>`);
    } else if (kind === "card") {
      items.push(`<div class="mx-skel-row">
        <div class="mx-skel mx-skel-line" style="width:40%;height:11px"></div>
        <div class="mx-skel mx-skel-line" style="width:80%;height:15px;margin-top:8px"></div>
        <div class="mx-skel mx-skel-line" style="width:30%;height:18px;margin-top:8px"></div>
        <div class="mx-skel mx-skel-line" style="width:60%;height:10px;margin-top:6px"></div>
      </div>`);
    } else {
      items.push(`<div class="mx-skel mx-skel-line" style="width:100%;height:14px"></div>`);
    }
  }
  return items.join("");
};

window.MX = MX;
window.dispatchEvent(new CustomEvent("mx:ready"));
