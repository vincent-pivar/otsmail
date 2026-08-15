import { parseHTML } from 'linkedom';

/**
 * 邮件正文消毒（Worker 侧）
 *
 * 用于任何要把邮件 HTML 送进浏览器渲染的地方（目前是 Telegram 推送里的
 * "查看邮件" 页面）。上游只做了 `document.querySelectorAll('script').remove()`，
 * 这远远不够 —— 以下都能绕过：
 *   <img src=x onerror=...>          事件属性
 *   <iframe src=javascript:...>      内联协议
 *   <svg><script>...                 命名空间内的脚本
 *   <a href="javascript:...">        链接协议
 *   <form action=...>                钓鱼表单
 *
 * 这里用 linkedom 解析成 DOM 后按白名单/黑名单清理，不用正则去啃 HTML。
 */

// 直接删除（连内容一起）的标签
const FORBIDDEN_TAGS = [
	'script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
	'textarea', 'select', 'option', 'base', 'link', 'meta', 'template',
	'noscript', 'frame', 'frameset', 'applet', 'audio', 'video', 'source',
	'title'
];

// 允许的 URL 协议（其余一律剔除属性）
const SAFE_URL_SCHEME = /^(?:https?:|mailto:|tel:|cid:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,|[/#?])/i;

// 带 URL 的属性
const URL_ATTRS = ['href', 'src', 'srcset', 'action', 'formaction', 'background', 'poster', 'data'];

// 无论如何都要删掉的属性
const FORBIDDEN_ATTRS = ['srcdoc', 'ping', 'formaction', 'http-equiv'];

function cleanStyleAttr(value) {
	if (!value) return '';
	// 挡掉 CSS 里能发起请求 / 执行代码的写法
	return value
		.replace(/expression\s*\(/gi, 'none(')
		.replace(/url\s*\(\s*['"]?\s*javascript:/gi, 'url(about:blank')
		.replace(/behavior\s*:/gi, 'x-behavior:')
		.replace(/-moz-binding\s*:/gi, 'x-binding:');
}

/**
 * @param {string} html 不可信的邮件 HTML
 * @returns {string} 消毒后的 HTML 片段
 */
export function sanitizeEmailHtml(html) {
	if (!html) return '';

	let document;
	try {
		({ document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`));
	} catch (e) {
		console.error('sanitizeEmailHtml parse failed:', e);
		return '';
	}

	// 1. 删除危险标签
	document.querySelectorAll(FORBIDDEN_TAGS.join(',')).forEach(el => el.remove());

	// 2. 逐元素清理属性
	document.querySelectorAll('*').forEach(el => {
		// linkedom 的 attributes 在遍历中删除会错位，先拷一份名字
		const names = Array.from(el.attributes || []).map(a => a.name);

		for (const name of names) {
			const lower = name.toLowerCase();
			const value = el.getAttribute(name);

			// on* 事件属性
			if (lower.startsWith('on')) {
				el.removeAttribute(name);
				continue;
			}

			if (FORBIDDEN_ATTRS.includes(lower)) {
				el.removeAttribute(name);
				continue;
			}

			if (lower === 'style') {
				el.setAttribute(name, cleanStyleAttr(value));
				continue;
			}

			if (URL_ATTRS.includes(lower)) {
				const v = (value || '').trim().replace(/[\u0000-\u001F\u007F]/g, '');
				if (!SAFE_URL_SCHEME.test(v)) {
					el.removeAttribute(name);
				}
			}
		}

		// 外链一律新窗口打开且断开 opener
		if (el.tagName === 'A' && el.getAttribute('href')) {
			el.setAttribute('target', '_blank');
			el.setAttribute('rel', 'noopener noreferrer');
		}
	});

	return document.body.innerHTML;
}

export default sanitizeEmailHtml;
