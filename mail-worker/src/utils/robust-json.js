/**
 * 容错 JSON 解析：模型有时会用 ```json 包裹或前后带解释文字，
 * 这里剥掉围栏、截取第一个 { 到最后一个 } 再 parse。
 */
export function robustJsonParse(raw) {
	if (!raw || typeof raw !== 'string') return null;
	let s = raw.trim();
	s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	const start = s.indexOf('{');
	const end = s.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		return JSON.parse(s.slice(start, end + 1));
	} catch {
		return null;
	}
}
