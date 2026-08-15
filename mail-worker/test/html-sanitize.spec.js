import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from '../src/utils/html-sanitize.js';

/**
 * 邮件正文是完全不可信输入 —— 任何人往你的 catch-all 地址发一封邮件，
 * 正文 HTML 就会进入渲染路径。上游只做 `<script>` 移除，这里验证
 * 各类绕过手法都被挡住，同时正常邮件内容不被破坏。
 */
describe('html-sanitize / 邮件正文消毒', () => {

	describe('拦截 XSS 载荷', () => {
		const payloads = [
			['script 标签',            '<p>hi</p><script>alert(1)</script>',                      /script/i],
			['img onerror',            '<img src=x onerror="alert(1)">',                           /onerror/i],
			['svg 内 script',          '<svg><script>alert(1)</script></svg>',                     /script/i],
			['a javascript: 协议',     '<a href="javascript:alert(1)">click</a>',                  /javascript:/i],
			['iframe',                 '<iframe src="https://evil.com"></iframe>',                 /iframe/i],
			['iframe srcdoc',          '<iframe srcdoc="<script>alert(1)</script>"></iframe>',     /srcdoc|iframe/i],
			['form 钓鱼',              '<form action="https://evil.com"><input name=pw></form>',   /<form|<input/i],
			['body onload',            '<body onload="alert(1)"><p>x</p></body>',                  /onload/i],
			['style expression',       '<div style="width:expression(alert(1))">x</div>',          /expression\(/i],
			['style url(javascript:)', `<div style="background:url('javascript:alert(1)')">x</div>`, /javascript:/i],
			['object',                 '<object data="evil.swf"></object>',                        /<object/i],
			['embed',                  '<embed src="evil.swf">',                                   /<embed/i],
			['大写绕过 SCRIPT',        '<SCRIPT>alert(1)</SCRIPT>',                                /script/i],
			['大写事件属性',           '<div><span ONMOUSEOVER=alert(1)>x</span></div>',           /onmouseover/i],
			['meta refresh',           '<meta http-equiv="refresh" content="0;url=//evil">',       /<meta|http-equiv/i],
			['base 标签劫持相对链接',  '<base href="https://evil.com/">',                          /<base/i],
			['link 引入外部样式',      '<link rel="stylesheet" href="https://evil.com/x.css">',    /<link/i],
			['data:text/html 链接',    '<a href="data:text/html,<script>alert(1)</script>">x</a>', /data:text\/html/i],
		];

		for (const [name, input, mustNotMatch] of payloads) {
			it(name, () => {
				expect(sanitizeEmailHtml(input)).not.toMatch(mustNotMatch);
			});
		}
	});

	describe('保留正常邮件内容', () => {
		it('段落与 https 链接', () => {
			const out = sanitizeEmailHtml('<p>你好 <a href="https://ok.com">链接</a></p>');
			expect(out).toMatch(/ok\.com/);
			expect(out).toMatch(/你好/);
		});

		it('cid 内嵌图片（邮件内联图必需）', () => {
			expect(sanitizeEmailHtml('<img src="cid:abc123">')).toMatch(/cid:abc123/);
		});

		it('base64 内嵌图片', () => {
			const out = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
			expect(out).toMatch(/base64/);
		});

		it('表格与内联样式（营销邮件大量使用）', () => {
			const out = sanitizeEmailHtml('<table><tr><td style="color:red">x</td></tr></table>');
			expect(out).toMatch(/<td/);
			expect(out).toMatch(/color:red/);
		});

		it('mailto 链接', () => {
			expect(sanitizeEmailHtml('<a href="mailto:a@b.com">mail</a>')).toMatch(/mailto:a@b\.com/);
		});
	});

	describe('外链加固', () => {
		it('补上 target=_blank 与 rel=noopener noreferrer（防 tabnabbing）', () => {
			const out = sanitizeEmailHtml('<a href="https://ok.com">x</a>');
			expect(out).toMatch(/target="_blank"/);
			expect(out).toMatch(/rel="noopener noreferrer"/);
		});
	});

	describe('边界输入', () => {
		it('空值与非法输入不抛异常', () => {
			expect(sanitizeEmailHtml('')).toBe('');
			expect(sanitizeEmailHtml(null)).toBe('');
			expect(sanitizeEmailHtml(undefined)).toBe('');
		});

		it('纯文本原样保留', () => {
			expect(sanitizeEmailHtml('验证码是 123456')).toMatch(/123456/);
		});
	});
});
