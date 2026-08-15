import { describe, it, expect } from 'vitest';
import { detectLang } from '../src/utils/lang-detect.js';
import { robustJsonParse } from '../src/utils/robust-json.js';
import { htmlToPlainText, paragraphsToHtml, escapeHtml } from '../src/utils/html-utils.js';

describe('lang-detect / 语言粗判（用于跳过同语翻译）', () => {
	it('中文', () => expect(detectLang('你好世界这是一封中文邮件测试内容')).toBe('zh'));
	it('英文', () => expect(detectLang('Hello this is an English email for testing')).toBe('en'));
	it('日文（含假名）', () => expect(detectLang('こんにちは、これはテストメールです')).toBe('ja'));
	it('韩文', () => expect(detectLang('안녕하세요 이것은 테스트 이메일입니다')).toBe('ko'));
	it('俄文', () => expect(detectLang('Привет это тестовое письмо на русском языке')).toBe('ru'));
	it('过短返回 und', () => expect(detectLang('hi')).toBe('und'));
	it('空值返回 und', () => {
		expect(detectLang('')).toBe('und');
		expect(detectLang(null)).toBe('und');
	});
	it('纯符号返回 und', () => expect(detectLang('!@#$%^&*()12345')).toBe('und'));
});

describe('robust-json / 容错解析模型输出', () => {
	it('裸 JSON', () => {
		expect(robustJsonParse('{"a":1}')).toEqual({ a: 1 });
	});
	it('```json 围栏', () => {
		expect(robustJsonParse('```json\n{"subject":"x","body":"y"}\n```'))
			.toEqual({ subject: 'x', body: 'y' });
	});
	it('前后带解释文字', () => {
		expect(robustJsonParse('Here is the result: {"ok":true} done'))
			.toEqual({ ok: true });
	});
	it('非法输入返回 null', () => {
		expect(robustJsonParse('no json here')).toBeNull();
		expect(robustJsonParse('')).toBeNull();
		expect(robustJsonParse(null)).toBeNull();
	});
});

describe('html-utils / 正文抽取与回包', () => {
	it('HTML 转纯文本，保留段落', () => {
		const t = htmlToPlainText('<p>第一段</p><p>第二段<br>换行</p><script>bad()</script>');
		expect(t).toContain('第一段');
		expect(t).toContain('第二段');
		expect(t).not.toContain('bad()');
	});
	it('escapeHtml 防注入', () => {
		expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
	});
	it('段落转 HTML', () => {
		const h = paragraphsToHtml('第一段\n\n第二段');
		expect(h).toBe('<p>第一段</p><p>第二段</p>');
	});
	it('段内换行转 br', () => {
		expect(paragraphsToHtml('a\nb')).toBe('<p>a<br>b</p>');
	});
});
