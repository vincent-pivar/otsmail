<template>
  <div class="content-box" ref="contentBox">
    <div ref="container" class="content-html"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import DOMPurify from 'dompurify'

const props = defineProps({
  html: {
    type: String,
    required: true
  }
})

const container = ref(null)
const contentBox = ref(null)
let shadowRoot = null

// 邮件正文是完全不可信的输入（任何人给你的地址发一封邮件就能投递 HTML）。
// Shadow DOM 只隔离样式，不是安全边界 —— 脚本照样在主页面上下文执行。
// 因此正文必须先经 DOMPurify 消毒再插入。
//
// 消毒策略：
//  - 禁止 script / iframe / object / embed / form 等可执行或可钓鱼的标签
//  - 禁止所有 on* 事件属性（DOMPurify 默认行为）
//  - 只允许 http / https / mailto / cid / data:image 这几类 URL，
//    显式挡掉 javascript: 与 data:text/html
//  - 外链统一加 target=_blank + rel=noopener noreferrer，避免 tabnabbing
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const PURIFY_CONFIG = {
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
                'textarea', 'select', 'base', 'link', 'meta'],
  FORBID_ATTR: ['srcdoc', 'formaction', 'ping'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|cid|tel):|data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml);base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  ALLOW_DATA_ATTR: false,
  KEEP_CONTENT: true
}

// <body style="..."> 的内容会被拼进我们的 <style> 里，未经处理时可以用
// `}` 提前闭合选择器并注入任意 CSS 规则（界面伪装 / 内容遮挡）。
// 这里只保留一段单纯的声明串，剔除会改变 CSS 结构的字符。
function sanitizeInlineStyle(style) {
  if (!style) return ''
  return style
    .replace(/[<>{}@;]/g, ' ')
    .replace(/url\s*\(/gi, 'none(')
    .replace(/expression\s*\(/gi, 'none(')
    .slice(0, 500)
}

function updateContent() {
  if (!shadowRoot) return;

  // 1. 提取 <body> 的 style 属性（如果存在）
  const bodyStyleRegex = /<body[^>]*style="([^"]*)"[^>]*>/i;
  const bodyStyleMatch = props.html.match(bodyStyleRegex);
  const bodyStyle = sanitizeInlineStyle(bodyStyleMatch ? bodyStyleMatch[1] : '');

  // 2. 移除 <body> 标签（保留内容）
  const strippedHtml = props.html.replace(/<\/?body[^>]*>/gi, '');

  // 3. 消毒正文
  const cleanedHtml = DOMPurify.sanitize(strippedHtml, PURIFY_CONFIG);

  // 4. 将 body 的 style 应用到 .shadow-content
  shadowRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        width: 100%;
        height: 100%;
        font-family: -apple-system, Inter, BlinkMacSystemFont,
                    'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #13181D;
        word-break: break-word;
      }

      h1, h2, h3, h4 {
          font-size: 18px;
          font-weight: 700;
      }

      p {
        margin: 0;
      }

      a {
        text-decoration: none;
        color: #0E70DF;
      }

      .shadow-content {
        background: #FFFFFF;
        width: fit-content;
        height: fit-content;
        min-width: 100%;
        ${bodyStyle ? bodyStyle : ''} /* 注入 body 的 style */
      }

      img:not(table img) {
        max-width: 100%;
        height: auto !important;
      }

    </style>
    <div class="shadow-content">
      ${cleanedHtml}
    </div>
  `;
}

function autoScale() {
  if (!shadowRoot || !contentBox.value) return

  const parent = contentBox.value
  const shadowContent = shadowRoot.querySelector('.shadow-content')

  if (!shadowContent) return

  const parentWidth = parent.offsetWidth
  const childWidth = shadowContent.scrollWidth

  if (childWidth === 0) return

  const scale = parentWidth / childWidth

  const hostElement = shadowRoot.host
  hostElement.style.zoom = scale
}

onMounted(() => {
  shadowRoot = container.value.attachShadow({ mode: 'open' })
  updateContent()
  autoScale()
})

watch(() => props.html, () => {
  updateContent()
  autoScale()
})
</script>

<style scoped>
.content-box {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, Inter, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
}

.content-html {
  width: 100%;
  height: 100%;
}
</style>
