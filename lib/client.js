// dsh-cost-chip —— 浏览器半边。
//
// 只显示：一个药丸（本会话花费）+ 点开的弹层（今日花费、余额）。
// 数字全部来自 host 半边的 `/api/dsh-cost-chip/summary`，这里不记账。
window.__ModuleLoader__.load({
	id: 'dsh-cost-chip',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		const react = require('react')
		const jsxRuntime = require('react/jsx-runtime')
		const jsx = jsxRuntime.jsx
		const jsxs = jsxRuntime.jsxs
		const Fragment = react.Fragment

		const NS = 'costChip'
		/** 版本号只在这里出现一次：探针、自检、渲染兜底都引它，免得三处漂移。 */
		const VERSION = '0.4.0'

		const zh = {
			'session': '本会话',
			'sessionToday': '今日',
			'sessionBefore': '之前',
			'today': '今日全部',
			'others': '其他 {n} 个工作区',
			'balance': '余额',
			'calls': '{n} 次调用',
			'note': '官方价表',
			'noteBuiltin': '内置价表（从未同步成功）',
			'noteStale': '价表同步失败，沿用上次的价',
			'priceAgo': '{n}前同步',
			'minutes': '{n} 分钟',
			'hours': '{n} 小时',
			'days': '{n} 天',
			'holidayCaveat': '缺 {years} 年放假安排，该年节假日按高峰计',
			'peak': '峰',
			'offpeak': '谷',
			'idleSlot': '空闲时段',
			'breakdown': '成本构成 · {scope}',
			'scopeToday': '本会话今日',
			'scopeTotal': '本会话累计',
			'scopeAll': '今日全部',
			'bucketMiss': '缓存未命中',
			'bucketHit': '缓存命中',
			'bucketOut': '输出',
			'tokens': '{n} tokens',
			'moreModels': '其他 {n} 个模型',
			'loading': '读取中',
			'unavailable': '暂不可用',
			'noKey': '未配置 API Key',
			'tipToday': '本会话今日花费，点开看明细与余额',
			'tipTotal': '本会话累计花费，点开看明细与余额',
			'tipAll': '今日全部花费，点开看明细与余额',
		}
		const en = {
			'session': 'Session',
			'sessionToday': 'today',
			'sessionBefore': 'earlier',
			'today': 'All sessions today',
			'others': '{n} more workspaces',
			'balance': 'Balance',
			'calls': '{n} calls',
			'note': 'Official price table',
			'noteBuiltin': 'Built-in prices (no successful sync yet)',
			'noteStale': 'Sync failed; last known prices kept',
			'priceAgo': 'synced {n} ago',
			'minutes': '{n} min',
			'hours': '{n} h',
			'days': '{n} d',
			'holidayCaveat': 'No holiday calendar for {years}; those days count as peak',
			'peak': 'peak',
			'offpeak': 'off-peak',
			'idleSlot': 'off-peak',
			'breakdown': 'Cost · {scope}',
			'scopeToday': 'this session today',
			'scopeTotal': 'this session total',
			'scopeAll': 'all sessions today',
			'bucketMiss': 'uncached input',
			'bucketHit': 'cache hit',
			'bucketOut': 'output',
			'tokens': '{n} tokens',
			'moreModels': '{n} more models',
			'loading': 'Loading',
			'unavailable': 'Unavailable',
			'noKey': 'No API key',
			'tipToday': 'Session cost today; click for details and balance',
			'tipTotal': 'Session total cost; click for details and balance',
			'tipAll': 'All spend today; click for details and balance',
		}

		const CSS = `
.dcc-root{position:relative;display:inline-flex;align-items:center;flex:none;order:1}
.dcc-chip{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:999px;
  padding:2px 9px;background:transparent;cursor:pointer;font:inherit;font-size:13px;
  line-height:18px;color:var(--dsw-alias-label-tertiary,#8b8f96);white-space:nowrap}
.dcc-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#5f6368)}
.dcc-chip[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#5f6368)}
.dcc-dot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.55}
.dcc-peak{font-size:10px;line-height:14px;padding:0 5px;border-radius:999px;
  background:rgba(77,107,254,.14);color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dcc-peak[data-off="true"]{background:rgba(63,185,80,.14);color:var(--dsw-alias-state-success-primary,#3fb950)}
.dcc-pop{position:absolute;right:0;bottom:calc(100% + 10px);z-index:80;width:264px;
  box-sizing:border-box;padding:10px 12px;border-radius:12px;
  max-height:min(70vh,440px);overflow-y:auto;overscroll-behavior:contain;
  background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#2a2b2f));
  color:var(--dsw-alias-label-primary,#e8eaed);
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
  box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:18px;text-align:left}
.dcc-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:3px 0}
.dcc-row dt{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.dcc-row dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600}
.dcc-sub{margin-top:-1px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f96)}
.dcc-subrow{display:flex;justify-content:space-between;gap:10px;padding:1px 0 1px 10px}
.dcc-wsname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcc-wscost{flex:none;font-variant-numeric:tabular-nums}
.dcc-sep{height:1px;margin:7px 0;background:var(--dsw-alias-border-l2,rgba(127,127,127,.28))}
.dcc-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b8f96)}
.dcc-warn{color:var(--dsw-alias-state-warn-label,#d29922)}
`
		const TAG = 'dsh-cost-chip/cost-chip.css'
		if (typeof document !== 'undefined') {
			const selector = 'style[data-plugin-css=' + JSON.stringify(TAG) + ']'
			const existing = document.querySelector(selector)
			if (existing === null) {
				const tag = document.createElement('style')
				tag.dataset.plugin = 'dsh-cost-chip'
				tag.dataset.pluginCss = TAG
				tag.textContent = CSS
				document.head.appendChild(tag)
			} else {
				// HMR 会重新执行这个 bundle，旧 style 标签还在，必须更新内容。
				existing.textContent = CSS
			}
		}

		/** 金额：两位小数；小于一分钱时不显示成一串 0。 */
		function money(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
			if (value > 0 && value < 0.01) return '<¥0.01'
			return '¥' + value.toFixed(2)
		}

		/**
		 * 余额：账户服务给的是十进制**字符串**，可能带十几位小数
		 * （`73.7221026000000000`）。原样显示会变成一串数字，这里压到两位。
		 * 非数字串就原样返回，别把它显示成 NaN。
		 */
		function amount(value) {
			const number = Number(value)
			return Number.isFinite(number) ? number.toFixed(2) : String(value)
		}

		/**
		 * 把一组金额折算成**和为 100** 的整数百分比。
		 *
		 * 各自独立四舍五入会出现 42 + 30 + 29 = 101 这种；最大余数法保证和正好
		 * 100，多出来的那 1% 落在余数最大的项上。
		 */
		function percentages(values, total) {
			const exact = values.map((value) => (value / total) * 100)
			const floors = exact.map((value) => Math.floor(value))
			let rest = 100 - floors.reduce((sum, value) => sum + value, 0)
			const order = exact
				.map((value, index) => ({ index, remainder: value - floors[index] }))
				.sort((left, right) => right.remainder - left.remainder)
			for (const item of order) {
				if (rest <= 0) break
				floors[item.index] += 1
				rest -= 1
			}
			return floors
		}

		/** 模型名的公共前缀在弹层里是噪音，去掉：`deepseek-v4-pro` → `v4-pro`。 */
		function shortModel(name) {
			return typeof name === 'string' && name.length > 0 ? name.replace(/^deepseek-/, '') : '—'
		}

		function fmt(template, vars) {
			return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole))
		}

		/** 把「多久之前同步的」压缩成一个人眼能读的量。 */
		function ageText(t, ageMs) {
			if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return ''
			const minutes = Math.max(1, Math.round(ageMs / 60000))
			if (minutes < 60) return fmt(t('minutes'), { n: minutes })
			const hours = Math.round(minutes / 60)
			if (hours < 48) return fmt(t('hours'), { n: hours })
			return fmt(t('days'), { n: Math.round(hours / 24) })
		}

		function Chip(props) {
			// 文案取值一律走这个包装：locale 服务没注入、namespace 没命中、或者返回了
			// 非字符串，都退化成 key 本身。直接拿 undefined 去 replace 会让整个组件在
			// 数据到达后的那次渲染里抛异常，然后被渲染器的 error boundary 摘掉——
			// 表现就是「挂上了、但页面里什么都没有」。
			const rawT = typeof props.t === 'function' ? props.t : (key) => key
			const t = (key) => {
				try {
					const value = rawT(key)
					return typeof value === 'string' ? value : key
				} catch {
					return key
				}
			}
			const sessionId = props.sessionId
			const [data, setData] = react.useState(null)
			const [error, setError] = react.useState(null)
			const [open, setOpen] = react.useState(false)
			const rootRef = react.useRef(null)
			/** 自检只报一次挂载 + 一次首次打开，避免每轮轮询都写探针文件。 */
			const diagRef = react.useRef({ fired: false, openFired: false })

			const load = react.useCallback(
				(signal) => {
					const query = typeof sessionId === 'string' && sessionId.length > 0
						? '?session=' + encodeURIComponent(sessionId)
						: ''
					return fetch('/api/dsh-cost-chip/summary' + query, { signal })
						.then((response) => {
							if (!response.ok) throw new Error('HTTP ' + response.status)
							return response.json()
						})
						.then((payload) => {
							if (payload !== null && payload.ok === true) {
								setData(payload)
								setError(null)
							} else {
								setError(payload?.error?.message ?? 'bad payload')
							}
						})
						.catch((reason) => {
							if (reason?.name === 'AbortError') return
							setError(String(reason?.message ?? reason))
						})
				},
				[sessionId],
			)

			// 挂载打卡：只为了让「插件真的进了页面」可被外部确认，失败无所谓。
			react.useEffect(() => {
				const session = typeof sessionId === 'string' && sessionId.length > 0
					? '&session=' + encodeURIComponent(sessionId)
					: ''
				fetch('/api/dsh-cost-chip/hello?v=' + VERSION + session).catch(() => {})
			}, [sessionId])

			// 换会话立即重取；之后每 20 秒兜底一次（消息落盘后数字才会变）。
			react.useEffect(() => {
				const controller = new AbortController()
				void load(controller.signal)
				const timer = setInterval(() => {
					void load(controller.signal)
				}, 20000)
				return () => {
					controller.abort()
					clearInterval(timer)
				}
			}, [load])

			// 打开时立刻刷一次，然后 5 秒一次：生成长回复时看得见数字在动。
			react.useEffect(() => {
				if (!open) return undefined
				const controller = new AbortController()
				void load(controller.signal)
				const timer = setInterval(() => {
					void load(controller.signal)
				}, 5000)
				return () => {
					controller.abort()
					clearInterval(timer)
				}
			}, [open, load])

			// 点外面或按 Esc 收起。
			react.useEffect(() => {
				if (!open) return undefined
				const onPointerDown = (event) => {
					const root = rootRef.current
					if (root !== null && !root.contains(event.target)) setOpen(false)
				}
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false)
				}
				document.addEventListener('pointerdown', onPointerDown, true)
				document.addEventListener('keydown', onKeyDown)
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true)
					document.removeEventListener('keydown', onKeyDown)
				}
			}, [open])

			// 自检：把药丸在页面里的真实位置、尺寸、样式报回 host。渲染了却看不见时，
			// 这是唯一能拿到证据的通道（接口带鉴权，外部进不来）。
			// 只在挂载后和弹层第一次打开时各报一次，别每轮轮询都写盘。
			react.useEffect(() => {
				const timer = setTimeout(() => {
					// 真正「报不报」在定时器里判：effect 会在 data 变化时重跑并清掉上一个
					// 定时器，把判断放在 effect 开头会让第一次的定时器永远等不到。
					const state = diagRef.current
					if (state.fired && !(open && !state.openFired)) return
					const root = rootRef.current
					if (root === null) return
					state.fired = true
					if (open) state.openFired = true
					const rect = root.getBoundingClientRect()
					const style = window.getComputedStyle(root)
					const parent = root.parentElement
					const dock = document.querySelector('[data-composer-dock]')
					const info = {
						v: VERSION,
						rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
						display: style.display,
						visibility: style.visibility,
						opacity: style.opacity,
						color: style.color,
						parent: parent === null
							? null
							: {
								tag: parent.tagName,
								cls: String(parent.className).slice(0, 70),
								w: Math.round(parent.getBoundingClientRect().width),
								overflow: window.getComputedStyle(parent).overflow,
							},
						dock: dock === null
							? null
							: { children: dock.children.length, cls: String(dock.className).slice(0, 50) },
						text: String(root.textContent ?? '').slice(0, 80),
						hasData: data !== null,
						error,
						sessionId: typeof sessionId === 'string' ? sessionId : null,
						apiSession: data?.session === null || data?.session === undefined ? null : {
							id: data.session.id,
							cost: data.session.cost,
							calls: data.session.calls,
							today: data.session.today ?? null,
							before: data.session.before ?? null,
						},
						apiToday: data?.today === undefined ? null : { cost: data.today.cost, calls: data.today.calls },
						pop: (() => {
							// 弹层只有打开时才在 DOM 里：采样它的真实配色，确认没有「白底白字」。
							const pop = root.querySelector('.dcc-pop')
							if (pop === null) return null
							const popStyle = window.getComputedStyle(pop)
							return { bg: popStyle.backgroundColor, color: popStyle.color, border: popStyle.borderTopColor }
						})(),
					}
					fetch('/api/dsh-cost-chip/hello?v=' + VERSION + '&diag=' + encodeURIComponent(JSON.stringify(info))).catch(() => {})
				}, 1500)
				return () => clearTimeout(timer)
			}, [data, error, open])

			const session = data?.session ?? null
			const today = data?.today ?? null
			const balance = data?.balance ?? null
			const pricing = data?.pricing ?? null
			const peak = pricing?.peak === true

			// 药丸默认显示**本会话今日**：跨天的会话如果用累计数，今天只花了两块钱也会
			// 显示成五十块，看不出今天的实际消耗。想看累计可用 DSH_COST_CHIP_CHIP=total，
			// 想看所有会话今天就设 all。
			const chipMode = data?.chip === 'total' || data?.chip === 'all' ? data.chip : 'today'
			let chipValue = null
			if (data !== null) {
				if (chipMode === 'all') chipValue = today === null ? null : today.cost
				else if (chipMode === 'total') chipValue = session === null ? null : session.cost
				// 旧版 host 没有 session.today，退回累计值而不是显示 0。
				else chipValue = session === null ? null : (session.today?.cost ?? session.cost)
			}
			const chipLabel = money(chipValue)
			const chipTip = t(chipMode === 'all' ? 'tipAll' : chipMode === 'total' ? 'tipTotal' : 'tipToday')

			try {

			const rows = []
			rows.push(
				jsxs(
					'div',
					{
						className: 'dcc-row',
						children: [
							jsx('dt', { className: 'dcc-sub', style: { margin: 0 }, children: t('session') }),
							// 这一行永远是**累计**：下面两行才是今日/之前。药丸上那个按 chip 模式变。
							jsx('dd', { children: money(session === null ? null : session.cost) }),
						],
					},
					'session',
				),
			)
			if (session !== null) {
				// 本会话拆两行：会话跨天时，一个总数看不出今天到底烧了多少。
				// host 还没更新（旧版只给总数）时退回原来那行，别显示成两个 0。
				const subRow = (key, label, part) => jsxs(
					'div',
					{
						className: 'dcc-sub dcc-subrow',
						children: [
							jsx('span', { children: label }),
							jsx('span', { children: `${money(part?.cost ?? 0)} · ${fmt(t('calls'), { n: part?.calls ?? 0 })}` }),
						],
					},
					key,
				)
				if (session.today !== undefined && session.before !== undefined) {
					rows.push(subRow('session-today', t('sessionToday'), session.today))
					rows.push(subRow('session-before', t('sessionBefore'), session.before))
				} else {
					rows.push(
						jsx('div', { className: 'dcc-sub', style: { textAlign: 'right' }, children: fmt(t('calls'), { n: session.calls }) }, 'session-calls'),
					)
				}
			}
			// 成本构成：解释**药丸上那个数**（按 chip 模式选口径）。三个计费桶的单价
			// 差 50 倍，「钱花在哪」比「花了多少」更能指导下一步；只有总价没有构成，
			// 看数字的人只能瞎猜。旧版 host 没有 bucket 字段，整块自动跳过。
			const scope = chipMode === 'all' ? 'all' : chipMode === 'total' ? 'total' : 'today'
			let breakdown = scope === 'all' ? today : scope === 'total' ? session : (session?.today ?? session)
			if (breakdown === null || breakdown === undefined) breakdown = today
			if (breakdown !== null && breakdown !== undefined && breakdown.bucket !== undefined && breakdown.cost > 0) {
				const total = breakdown.cost
				const buckets = [
					['miss', t('bucketMiss'), breakdown.bucket.miss ?? 0, breakdown.miss ?? 0],
					['hit', t('bucketHit'), breakdown.bucket.hit ?? 0, breakdown.hit ?? 0],
					['out', t('bucketOut'), breakdown.bucket.out ?? 0, breakdown.out ?? 0],
				].sort((left, right) => right[2] - left[2])
				const shares = percentages(buckets.map((item) => item[2]), total)
				const scopeLabel = t(scope === 'all' ? 'scopeAll' : scope === 'total' ? 'scopeTotal' : 'scopeToday')
				rows.push(jsx('div', {
					className: 'dcc-note',
					style: { marginTop: '4px' },
					children: fmt(t('breakdown'), { scope: scopeLabel }),
				}, 'breakdown-title'))
				buckets.forEach(([key, label, cost, tokens], index) => {
					rows.push(jsxs('div', {
						className: 'dcc-sub dcc-subrow',
						// token 数放悬停：行里已经有金额和占比，再塞一列就读不动了。
						title: fmt(t('tokens'), { n: Math.round(tokens).toLocaleString() }),
						children: [
							jsx('span', { className: 'dcc-wsname', children: label }),
							jsx('span', { className: 'dcc-wscost', children: `${money(cost)} · ${shares[index]}%` }),
						],
					}, `bucket-${key}`))
				})
				// 按模型：会话中途换过模型时才出现。pro 比 flash 贵好几倍，
				// 「为什么这一天这么贵」的另一半答案在这儿。
				const models = Array.isArray(breakdown.models) ? breakdown.models : []
				if (models.length > 1) {
					for (const entry of models.slice(0, 2)) {
						rows.push(jsxs('div', {
							className: 'dcc-sub dcc-subrow',
							children: [
								jsx('span', { className: 'dcc-wsname', children: shortModel(entry.model) }),
								jsx('span', { className: 'dcc-wscost', children: money(entry.cost) }),
							],
						}, `model-${entry.key ?? entry.model}`))
					}
					if (models.length > 2) {
						const rest = models.slice(2)
						rows.push(jsxs('div', {
							className: 'dcc-sub dcc-subrow',
							children: [
								jsx('span', { className: 'dcc-wsname', children: fmt(t('moreModels'), { n: rest.length }) }),
								jsx('span', { className: 'dcc-wscost', children: money(rest.reduce((sum, item) => sum + item.cost, 0)) }),
							],
						}, 'model-rest'))
					}
				}
			}
			rows.push(jsx('div', { className: 'dcc-sep' }, 'sep'))
			rows.push(
				jsxs(
					'div',
					{
						className: 'dcc-row',
						children: [
							jsx('dt', { className: 'dcc-sub', style: { margin: 0 }, children: t('today') }),
							jsx('dd', { children: today === null ? '—' : money(today.cost) }),
						],
					},
					'today',
				),
			)
			if (today !== null) {
				rows.push(
					jsx('div', { className: 'dcc-sub', style: { textAlign: 'right' }, children: fmt(t('calls'), { n: today.calls }) }, 'today-calls'),
				)
				// 按工作区拆：最多四行，剩下的合成「其他 N 个」。当前工作区加个点标出来。
				const currentName = data?.workspace?.name ?? null
				const list = today.workspaces ?? []
				const wsRow = (key, name, cost, isCurrent) => jsxs(
					'div',
					{ className: 'dcc-sub dcc-subrow', children: [
						jsx('span', {
							className: 'dcc-wsname',
							children: `${isCurrent ? '· ' : ''}${name}`,
						}),
						jsx('span', { className: 'dcc-wscost', children: money(cost) }),
					] },
					key,
				)
				for (const item of list.slice(0, 4)) {
					rows.push(wsRow(`ws-${item.name}`, item.name, item.cost, item.name === currentName))
				}
				if (list.length > 4) {
					const rest = list.slice(4)
					rows.push(wsRow('ws-rest', fmt(t('others'), { n: rest.length }), rest.reduce((sum, item) => sum + item.cost, 0), false))
				}
			}
			rows.push(jsx('div', { className: 'dcc-sep' }, 'sep2'))
			rows.push(
				jsxs(
					'div',
					{
						className: 'dcc-row',
						children: [
							jsx('dt', { className: 'dcc-sub', style: { margin: 0 }, children: t('balance') }),
							jsx('dd', {
								children:
									balance === null
										? '—'
										: balance.ok === true
											? (balance.currency === 'CNY' ? '¥' : '') + amount(balance.total)
											: t('unavailable'),
							}),
						],
					},
					'balance',
				),
			)
			if (balance !== null && balance.ok !== true) {
				rows.push(jsx('div', { className: 'dcc-sub dcc-warn', children: balance.code === 'no-api-key' ? t('noKey') : balance.message }, 'balance-err'))
			}

			// 价表状态：官方页同步来的就写「多久前同步的」，同步失败就明说沿用的是上次的价。
			let priceLine = null
			if (pricing !== null) {
				// 一直是内置表就明说「从未同步成功」，别把「从来没同步过」说成「沿用上次的价」。
				if (pricing.source === 'builtin') priceLine = t('noteBuiltin')
				else if (pricing.ok === false) priceLine = t('noteStale')
				else {
					const age = ageText(t, pricing.ageMs)
					priceLine = age.length > 0 ? `${t('note')} · ${fmt(t('priceAgo'), { n: age })}` : t('note')
				}
				// 现在按谷价计费就说一句。药丸上不再常显「谷」（那是默认态，常显只是噪音），
				// 想知道当前处在哪个计费时段就点开看这一行。
				if (pricing.peak === false) priceLine = `${priceLine} · ${t('idleSlot')}`
			}
			if (priceLine !== null) {
				// 悬停给精确时刻：「58 分钟前」这种相对说法看不出是哪一次抓的。
				const stamp = typeof pricing?.fetchedAt === 'number' && pricing.fetchedAt > 0
					? new Date(pricing.fetchedAt).toLocaleString()
					: undefined
				rows.push(jsx('div', { className: 'dcc-note', style: { marginTop: '6px' }, title: stamp, children: priceLine }, 'note'))
			}
			// 未来年份的日历本来就要等到年底才公布，不必提示；只有当年缺日历才说一句。
			if (pricing !== null && pricing.holidaysOffPeak === true && pricing.holidays?.missingCurrentYear === true) {
				rows.push(jsx('div', {
					className: 'dcc-note dcc-warn',
					children: fmt(t('holidayCaveat'), { years: String(new Date().getFullYear()) }),
				}, 'holiday'))
			}

			const popover = open
				? jsx('div', { className: 'dcc-pop', role: 'dialog', 'aria-label': t('today'), children: jsx('dl', { style: { margin: 0 }, children: rows }) }, 'pop')
				: null

			const chipChildren = [
				jsx('span', { className: 'dcc-dot', 'aria-hidden': true }, 'dot'),
				jsx('span', { children: chipLabel }, 'label'),
			]
			// 只有高峰才挂那个小标：谷价是默认态，常显等于每行都写「正常」。
			if (data !== null && peak) {
				chipChildren.push(
					jsx('span', { className: 'dcc-peak', 'data-off': 'false', children: t('peak') }, 'peak'),
				)
			}

			return jsxs(Fragment, {
				children: [
					jsxs(
						'div',
						{
							ref: rootRef,
							className: 'dcc-root',
							style: { order: 1 },
							children: [
								jsx('button', {
									type: 'button',
									className: 'dcc-chip',
									'data-open': open ? 'true' : 'false',
									title: chipTip,
									'aria-expanded': open,
									onClick: () => setOpen((value) => !value),
									children: chipChildren,
								}, 'chip'),
								popover,
							],
						},
						'root',
					),
				],
			})
			} catch (reason) {
				// 渲染炸了也不能让药丸整个消失：留一个最小可点的东西，并把错误报回去。
				const message = String(reason?.message ?? reason)
				fetch('/api/dsh-cost-chip/hello?v=' + VERSION + '&diag=' + encodeURIComponent(JSON.stringify({ renderError: message }))).catch(() => {})
				return jsx('div', {
					className: 'dcc-root',
					style: { order: 1 },
					children: jsx('button', {
						type: 'button',
						className: 'dcc-chip',
						title: message,
						children: '¥—',
					}, 'fallback-chip'),
				}, 'fallback')
			}
		}

		const inject = ['slots', 'locale']

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cost-chip: dictionaries')
			ctx.slots.inject('conversation.composer.dock', () => {
				const dispose = ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'dsh-cost-chip',
						// 数字大 = 排在列表末尾；实际落在上下文圆环哪一侧由 CSS 的 order 决定。
						order: 1000,
						locale: NS,
					},
					Chip,
				)
				return () => dispose()
			})
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
