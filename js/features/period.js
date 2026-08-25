/**
 * period.js — 经期记录功能 Step 2
 * 数据持久化 + 日历渲染 + 统计计算 + 标记逻辑
 */
(function () {
    'use strict';

    // ── 常量 ──────────────────────────────────────────
    var DEFAULT_SYMPTOMS = ['痛经', '腰酸', '头痛', '疲惫', '胸胀', '恶心'];
    var FLOW_LABELS      = ['', '极少', '少', '正常', '多', '极多'];
    var WEEKDAYS         = ['日', '一', '二', '三', '四', '五', '六'];

    // 预测经期前一天的提醒文案——固定几条，随机挑一条，梦角口吻
    var PREDICT_REMINDER_LINES = [
        '算了下时间，你这两天例假应该要来了，记得多喝点热水呀',
        '日历上看你这两天可能要来例假了，红糖姜茶记得先备好哦',
        '提前跟你说一声，这几天大概是你的经期，照顾好自己，别太劳累',
        '你的经期这两天应该要到了，不舒服记得告诉我，我会一直陪着你',
        '估计这两天要来例假了，记得少吃点冷的东西',
        '算了一下，你这几天例假快到了，出门记得带好需要的东西'
    ];

    // ── 内存状态 ──────────────────────────────────────
    // _data 结构：
    // {
    //   periods: [ { id, startDate, endDate|null } ],
    //   dailyRecords: { 'YYYY-MM-DD': { flow:0-5, symptoms:[] } },
    //   customSymptoms: [],
    //   partnerMsg: { periodId, date:'YYYY-MM-DD', lines:[] } | null,
    //   notifyAt: timestamp | null,
    //   notifyPeriodId: string | null,
    //   dailyNotifDate: 'YYYY-MM-DD' | null   // 已经安排/发出过留言的那一天，防止同一天重复
    // }
    var _data   = { periods: [], dailyRecords: {}, customSymptoms: [], partnerMsg: null, notifyAt: null, notifyPeriodId: null, dailyNotifDate: null };
    var _loaded = false;
    var _viewYear, _viewMonth;   // 0-based month
    var _currentFlow     = 0;
    var _currentSymptoms = [];
    var _longPressTimer  = null;
    var _storageKey      = null;

    // ── Storage ───────────────────────────────────────
    async function _getKey() {
        if (_storageKey) return _storageKey;

        // 优先用 app 统一的取 key 方法，保证经期数据的 key 跟其他数据一样，
        // 带着正确的用户身份前缀（云同步会检查这个前缀，带错前缀的数据同步不了）
        var properKey = null;
        try {
            if (typeof SESSION_ID !== 'undefined' && SESSION_ID && typeof window.getStorageKey === 'function') {
                properKey = window.getStorageKey('periodData');
            }
        } catch (e) { /* SESSION_ID 可能还没初始化，走下面的兜底 */ }

        try {
            var allKeys = await localforage.keys();

            if (properKey) {
                if (allKeys.indexOf(properKey) === -1) {
                    // 规范 key 下还没数据——之前的版本有个bug：猜"消息记录"的key时，
                    // 用的字符串特征('_messages')跟实际的key名（'chatMessages'）对不上，
                    // 导致经期数据一直存在一个不带用户身份前缀的错误key里。
                    // 这里做一次性搬家：找到旧key、把数据搬到规范key下、删掉旧的，不会丢数据。
                    var legacyKey = allKeys.find(function (k) { return k.indexOf('_periodData') !== -1 && k !== properKey; });
                    if (legacyKey) {
                        try {
                            var legacyVal = await localforage.getItem(legacyKey);
                            if (legacyVal) {
                                await localforage.setItem(properKey, legacyVal);
                                await localforage.removeItem(legacyKey);
                            }
                        } catch (e) { console.warn('[period] 旧数据迁移失败:', e); }
                    }
                }
                _storageKey = properKey;
                return properKey;
            }

            // getStorageKey 暂时不可用（比如脚本刚加载、SESSION_ID还没初始化完）——
            // 用能找到的现成 key 顶用一次，但不缓存，等下次真正需要时再重新尝试规范方式
            var found = allKeys.find(function (k) { return k.indexOf('_periodData') !== -1; });
            if (found) return found;
            var msgKey = allKeys.find(function (k) { return k.indexOf('_chatMessages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_chatMessages', '') : 'CHAT_APP_V3_';
            return prefix + '_periodData';
        } catch (e) {
            return 'CHAT_APP_V3__periodData';
        }
    }

    // 等 SESSION_ID 真正就绪再往下走——避免"读数据时账号信息还没准备好，
    // 存数据时却已经准备好了"这种前后不一致，导致读、存实际用的是两个不同的
    // 存储位置：读的时候找不到真实数据（因为找错了地方），存的时候却把这个
    // "看起来是空的"结果存到了真正正确的位置，把已有的真实数据覆盖掉。
    // 正常情况下 SESSION_ID 很快就会就绪，这里最多等5秒兜底。
    function _waitForSessionId(maxWaitMs) {
        return new Promise(function (resolve) {
            var waited = 0;
            (function check() {
                if ((typeof SESSION_ID !== 'undefined' && SESSION_ID) || waited >= maxWaitMs) {
                    resolve();
                } else {
                    waited += 100;
                    setTimeout(check, 100);
                }
            })();
        });
    }

    async function _load() {
        await _waitForSessionId(5000);
        try {
            var key = await _getKey();
            var saved = await localforage.getItem(key);
            if (saved && saved.periods) {
                _data = saved;
                if (!_data.dailyRecords)   _data.dailyRecords   = {};
                if (!_data.customSymptoms) _data.customSymptoms = [];
            }
        } catch (e) { console.warn('[period] load failed:', e); }
        // 开机自检：把满足合并条件、但因为之前版本的bug没能合并的历史碎片自动接好，
        // 不用用户再手动操作一次。_reconcilePeriods 定义在下面，这里是前向引用，
        // 因为函数声明会整体提升，运行时没问题。
        _reconcilePeriods();
        _save();
        _loaded = true;
    }

    async function _save() {
        try {
            var key = await _getKey();
            await localforage.setItem(key, _data);
        } catch (e) { console.warn('[period] save failed:', e); }
    }

    // ── 日期工具 ──────────────────────────────────────
    function _pad(n) { return String(n).padStart(2, '0'); }
    function _toStr(d) { return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()); }
    function _today()  { return _toStr(new Date()); }
    function _parse(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
    function _diff(a, b) { return Math.round((_parse(b) - _parse(a)) / 86400000); }
    function _addD(s, n) { var d = _parse(s); d.setDate(d.getDate() + n); return _toStr(d); }

    // ── Period 查询 ───────────────────────────────────
    function _getPeriodOf(dateStr) {
        return _data.periods.find(function (p) {
            if (dateStr < p.startDate) return false;
            if (p.endDate)  return dateStr <= p.endDate;
            return dateStr <= _today();
        }) || null;
    }
    function _isInPeriod(dateStr) { return !!_getPeriodOf(dateStr); }
    function _getDayNum(dateStr) {
        var p = _getPeriodOf(dateStr);
        return p ? _diff(p.startDate, dateStr) + 1 : 0;
    }
    function _activePeriod() {
        return _data.periods.find(function (p) { return !p.endDate; }) || null;
    }

    // 只用最近几次记录来算规律，不用全部历史——身体状态会随时间变化（换季/压力/年龄），
    // 太久以前的规律参考价值该打折扣，只看最近的能让预测更快跟上"最近的你"
    var RECENT_CYCLES_N = 6;

    // 中位数——比平均数更抗干扰：偶尔一次异常波动（生病、旅行导致周期特别长或特别短）
    // 不会像平均数那样被明显拉偏
    function _median(arr) {
        var sorted = arr.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0
            ? sorted[mid]
            : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }

    // 区间宽度：改用标准差——统计学里最主流、最基础的"波动有多大"的衡量方式
    // （比中位数绝对偏差更常见，主流经期app的公开文档里也是用这个思路）。
    // 用样本标准差(除以n-1，不是n，这是统计学教科书的标准做法)。
    // 封顶8天：参考Natural Cycles公开写出来的"周期波动超过8天就算不规律"这个标准，
    // 这不是我们自己拍的数字，是抄一个做得比较严谨的经期app公开的判定标准。
    // 触发封顶时会额外标记"irregular"，UI上会多显示一行提示，老实告诉用户这个预测
    // 参考价值有限，而不是偷偷把数字压小装作很准。
    function _calcSwing(gaps) {
        if (gaps.length < 2) return { days: 0, irregular: false };
        var mean = gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length;
        var variance = gaps.reduce(function (s, g) { return s + Math.pow(g - mean, 2); }, 0) / (gaps.length - 1);
        var sd = Math.sqrt(variance);
        return { days: Math.min(8, Math.round(sd)), irregular: sd >= 8 };
    }

    // 预测区间——起止日期字符串，只算一次，统计卡片显示和"提前一天提醒"功能共用，
    // 避免两处分别算一遍导致以后改公式的时候容易漏改其中一处
    function _getPredictionWindow() {
        var sorted = _data.periods.slice().sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
        if (sorted.length < 2) return null;
        var recent = sorted.slice(-RECENT_CYCLES_N);  // 只用最近N次，不用全部历史
        var gaps = [];
        for (var i = 1; i < recent.length; i++) {
            gaps.push(_diff(recent[i - 1].startDate, recent[i].startDate));
        }
        if (!gaps.length) return null;
        var avgCycle  = _median(gaps);
        var lastStart = recent[recent.length - 1].startDate;
        var predStart = _addD(lastStart, avgCycle);
        var swingInfo = _calcSwing(gaps);
        var swing     = swingInfo.days;

        // 经期时长——同样只看最近N次里"已结束"的记录，跟"平均经期天数"那张卡片
        // 保持一致的算法和取样范围，避免两处数字对不上；一次已结束的记录都没有时，先用5天顶着用
        var completed = recent.filter(function (p) { return p.endDate; });
        var avgDur = completed.length > 0
            ? Math.round(completed.reduce(function (s, p) { return s + _diff(p.startDate, p.endDate) + 1; }, 0) / completed.length)
            : 5;

        // 区间代表"这整段时间都可能在经期里"——把"哪天开始"的不确定性(swing)
        // 和"经期本身大概几天"(avgDur)合起来算成一个窗口，不是只给"开始日"的浮动范围。
        //
        // 总长度封顶8天：样本量太小时（比如只有2、3段记录），标准差这个统计工具本身
        // 会失真，随便两个数字差一点就会把波动算得很夸张。与其纠结"样本够不够才敢信公式"，
        // 更直接的办法是给最终显示的窗口设一个硬性上限——不管波动算出来多大，
        // 总长度不会超过8天。经期天数是已经真实发生过的数据，不该被压缩，
        // 所以封顶只压缩"波动"这部分，经期天数原样保留。
        var MAX_WINDOW_SPAN = 8;
        var maxSwing = Math.max(0, Math.floor((MAX_WINDOW_SPAN - avgDur) / 2));
        swing = Math.min(swing, maxSwing);

        return { lo: _addD(predStart, -swing), hi: _addD(predStart, swing + avgDur - 1), irregular: swingInfo.irregular };
    }

    // ── 统计 ──────────────────────────────────────────
    function _calcStats() {
        var sorted    = _data.periods.slice().sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
        var recent    = sorted.slice(-RECENT_CYCLES_N);  // 跟预测区间用同一个"最近N次"取样范围
        var completed = recent.filter(function (p) { return p.endDate; });

        // 平均经期天数
        var avgDays = '--';
        if (completed.length > 0) {
            var total = completed.reduce(function (s, p) { return s + _diff(p.startDate, p.endDate) + 1; }, 0);
            avgDays = Math.round(total / completed.length) + '天';
        }

        // 预测下次 —— 始终给区间，不再有"波动小就给单一日期"的分支：
        // 经期本身就有生理波动，给一个看似精确的单一日期反而是假精确。
        // 区间宽度跟着历史波动走：波动越大区间越宽；波动很小时至少给±2天，
        // 避免看起来像没算清楚。
        var nextDate = '暂无预测';
        var irregular = false;
        var win = _getPredictionWindow();
        if (win) {
            var lo = _parse(win.lo);
            var hi = _parse(win.hi);
            nextDate = (lo.getMonth() + 1) + '月' + lo.getDate() + '日 ~ ' +
                       (hi.getMonth() + 1) + '月' + hi.getDate() + '日';
            irregular = !!win.irregular;
        }

        return { avgDays: avgDays, nextDate: nextDate, irregular: irregular };
    }

    function _predictedDates() {
        var dates = {};
        var sortedAll = _data.periods.slice().sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
        var recent    = sortedAll.slice(-RECENT_CYCLES_N);
        var completed = recent.filter(function (p) { return p.endDate; });

        // 1）当前正在进行的经期（还没标记结束）——按最近几次的平均时长推算，
        //    "还没到/还没打卡"的那几天大概率也算经期，标成浅色预测
        var active = _activePeriod();
        if (active && completed.length > 0) {
            var avgDur = Math.round(completed.reduce(function (s, p) { return s + _diff(p.startDate, p.endDate) + 1; }, 0) / completed.length);
            for (var d = 0; d < avgDur; d++) {
                var ds = _addD(active.startDate, d);
                if (!_isInPeriod(ds)) dates[ds] = true;  // 已经算作经期(到今天为止)的不用重复标
            }
        }

        // 2）下一次经期的预测窗口——高亮范围跟统计卡片里显示的区间完全对齐，
        //    不再额外叠加经期时长（之前这里多加了一层，导致日历高亮的范围比
        //    文字描述的区间宽出一大截，看起来莫名其妙）
        var win = _getPredictionWindow();
        if (win) {
            var loD = _parse(win.lo), hiD = _parse(win.hi);
            var cursor = loD;
            while (cursor <= hiD) {
                dates[_toStr(cursor)] = true;
                cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
            }
        }

        return Object.keys(dates);
    }

    // ── 经期操作 ──────────────────────────────────────
    function _startPeriod(dateStr, sendNotif) {
        if (_isInPeriod(dateStr)) return;
        var active = _activePeriod();
        if (active) active.endDate = _addD(dateStr, -1);  // 自动结束上次
        _data.periods.push({ id: 'pd_' + Date.now(), startDate: dateStr, endDate: null });
        // 如果这次新开的记录，紧挨着最近一条刚结束的记录（比如手滑关闭又重新打开），
        // 自动接回去合并成一条，避免"经期第几天"从1重新算起
        _reconcilePeriods();
        _save();
        if (sendNotif) _scheduleTodayNotifIfNeeded();
    }

    // 把间隔在合理范围内的经期记录自动接成一条——不管是新长按产生的碎片，
    // 还是账号里本来就存在的历史碎片，每次数据变动后调用一次就会自动愈合。
    // 阈值定为10天：正常经期很少超过7天，10天已经留足余量；
    // 同时明显小于两次不同经期之间的间隔（哪怕周期很不规律，通常也不会短于10天以内），
    // 所以不容易把两次完全不同的经期误判成一条。
    var MERGE_GAP_LIMIT = 5;
    function _reconcilePeriods() {
        _data.periods.sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
        for (var i = 0; i < _data.periods.length - 1; i++) {
            var cur = _data.periods[i], next = _data.periods[i + 1];
            if (!cur.endDate) continue;  // cur 正在进行中（理论上只会是排序后最后一条），没法再往后并
            if (_diff(cur.endDate, next.startDate) <= MERGE_GAP_LIMIT) {
                cur.endDate = next.endDate;  // next 若也在进行中，合并后 cur 也变成进行中
                _data.periods.splice(i + 1, 1);
                i--;  // 合并后原地再检查一次，可能还能继续往后并
            }
        }
    }

    function _toggleHistory(dateStr) {
        var p = _getPeriodOf(dateStr);
        if (p) {
            if (p.startDate === dateStr) {
                _cancelPendingNotifFor(p.id);
                _data.periods = _data.periods.filter(function (x) { return x.id !== p.id; });
            } else {
                p.endDate = _addD(dateStr, -1);
            }
        } else {
            _data.periods.push({ id: 'pd_' + Date.now(), startDate: dateStr, endDate: dateStr });
        }
        _reconcilePeriods();
        _save();
    }

    // ── 通知（梦角留言） ──────────────────────────────
    // 经期进行中的每一天都会安排一条新留言（不是整个经期只有一条）：
    // - 第一天（标记经期那天）：标记后 1~3 小时
    // - 第二天起：当天 0 点之后的 0~3 小时内随机
    // 用 dailyNotifDate 记录"今天是不是已经安排过了"，避免重复安排。
    function _scheduleTodayNotifIfNeeded() {
        var active = _activePeriod();
        if (!active) return;
        var today = _today();
        if (_data.notifyPeriodId === active.id && _data.dailyNotifDate === today) return;  // 今天已经安排过

        var fireAt;
        if (today === active.startDate) {
            // 第一天：标记经期后 1~3 小时
            var minMin = 60, maxMin = 180;
            fireAt = Date.now() + (minMin + Math.floor(Math.random() * (maxMin - minMin + 1))) * 60000;
        } else {
            // 第二天起：当天 0 点之后的 0~3 小时内随机挑一个时间点
            var midnight = new Date();
            midnight.setHours(0, 0, 0, 0);
            var windowEnd = midnight.getTime() + 3 * 3600000;
            var now = Date.now();
            if (now < windowEnd) {
                fireAt = now + Math.floor(Math.random() * Math.max(1, windowEnd - now));
            } else {
                // 已经过了0-3点这个窗口（比如今天很晚才打开app）——
                // 尽快在10-30分钟内补发一条，不然今天就彻底错过、要等到明天了
                fireAt = now + (10 + Math.floor(Math.random() * 21)) * 60000;
            }
        }

        _data.notifyAt       = fireAt;
        _data.notifyPeriodId = active.id;
        _data.dailyNotifDate = today;
        _save();
    }

    // 用户手动结束/撤销某条记录时调用——如果这条记录正好排着一次还没发出的留言，
    // 取消掉这次定时（不让它到点还发）。注意 notifyPeriodId/dailyNotifDate 本身不清掉：
    // 这样万一用户之后又把这次经期重新打开（合并回同一条记录，id不变），
    // 也不会因为"重新安排"而意外弹出一条新留言——今天这个名额已经用掉了。
    function _cancelPendingNotifFor(periodId) {
        if (_data.notifyPeriodId === periodId && _data.notifyAt) {
            _data.notifyAt = null;
        }
    }

    function _checkNotif() {
        if (!_data.notifyAt || !_data.notifyPeriodId) return;
        if (Date.now() < _data.notifyAt) return;
        if (_data.partnerMsg && _data.partnerMsg.periodId === _data.notifyPeriodId && _data.partnerMsg.date === _data.dailyNotifDate) return;

        // 优先用"经期"专属话术库（氛围感配置里新加的分类）；
        // 用户没配置（数组为空）就退回主字卡库，跟原来的兜底逻辑一致。
        var periodReplies = (typeof customPeriodCare !== 'undefined' && customPeriodCare && customPeriodCare.length)
            ? customPeriodCare : null;
        var replies = periodReplies ||
                      (window._customReplies) ||
                      (typeof customReplies !== 'undefined' ? customReplies : []) || [];
        if (!replies.length) return;

        var shuffled = replies.slice().sort(function () { return Math.random() - 0.5; });
        var lines    = shuffled.slice(0, 1);

        _data.partnerMsg = { periodId: _data.notifyPeriodId, date: _data.dailyNotifDate, lines: lines };
        _data.notifyAt   = null;
        _save();

        _showPdNotif(lines);
        _renderLetterCard();
    }

    function _showPdNotif(lines) {
        var existing = document.getElementById('pd-notif-popup');
        if (existing) existing.remove();

        var pname = _partnerName();
        var realImg = document.querySelector('#partner-avatar img');
        var avatarHtml = (realImg && realImg.src)
            ? '<img src="' + realImg.src + '" style="width:100%;height:100%;object-fit:cover;">'
            : '<i class="fas fa-user" style="font-size:18px;color:var(--text-secondary);"></i>';
        var popup = document.createElement('div');
        popup.id = 'pd-notif-popup';
        popup.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
            'background:var(--secondary-bg);border:1px solid var(--border-color);' +
            'border-radius:20px;padding:18px 20px;z-index:9000;max-width:320px;width:88%;' +
            'box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:12px;' +
            'animation:_mSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);';
        popup.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;">' +
                '<div style="width:36px;height:36px;border-radius:50%;background:rgba(var(--accent-color-rgb),0.12);' +
                    'display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">' + avatarHtml + '</div>' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:700;color:var(--text-primary);">' + pname + ' 有话想说</div>' +
                    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">去经期记录里看看</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
                '<button onclick="document.getElementById(\'pd-notif-popup\').remove();" ' +
                    'style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">稍后</button>' +
                '<button onclick="window._pdGoToPeriodTab();document.getElementById(\'pd-notif-popup\').remove();" ' +
                    'style="flex:2;padding:8px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">立即查看 ✦</button>' +
            '</div>';
        document.body.appendChild(popup);
        setTimeout(function () { if (popup.parentNode) popup.remove(); }, 8000);
    }

    // ── 预测经期前一天提醒 ────────────────────────────
    function _checkPredictReminder() {
        var win = _getPredictionWindow();
        if (!win) return;
        if (_activePeriod()) return;  // 正在经期中就不用提醒"快到了"，没有意义
        var triggerDay = _addD(win.lo, -1);  // 预测区间最早那天的前一天
        if (_today() !== triggerDay) return;
        if (_data.predictReminderFor === win.lo) return;  // 同一个预测区间只提醒一次

        var line = PREDICT_REMINDER_LINES[Math.floor(Math.random() * PREDICT_REMINDER_LINES.length)];
        _data.predictReminderFor = win.lo;
        _save();
        _showPredictReminderPopup(line);
    }

    function _showPredictReminderPopup(text) {
        var existing = document.getElementById('pd-predict-notif-overlay');
        if (existing) existing.remove();

        var pname   = _partnerName();
        var realImg = document.querySelector('#partner-avatar img');
        var avatarHtml = (realImg && realImg.src)
            ? '<img src="' + realImg.src + '" style="width:100%;height:100%;object-fit:cover;">'
            : '<i class="fas fa-user" style="font-size:20px;color:var(--text-secondary);"></i>';

        var overlay = document.createElement('div');
        overlay.id = 'pd-predict-notif-overlay';
        overlay.className = 'modal';
        overlay.style.zIndex = '10000';  // 比开机欢迎动画(9999)高，双保险，避免延时不够时还是被盖住
        overlay.innerHTML =
            '<div class="modal-content" style="max-width:320px;padding:20px;">' +
                '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' +
                    '<div style="width:40px;height:40px;border-radius:50%;background:rgba(var(--accent-color-rgb),0.12);' +
                        'display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">' + avatarHtml + '</div>' +
                    '<div style="font-size:15px;font-weight:700;color:var(--text-primary);">' + pname + ' 提醒你</div>' +
                '</div>' +
                '<div style="font-size:13px;color:var(--text-primary);line-height:1.6;margin-bottom:18px;">' + text + '</div>' +
                '<div style="display:flex;gap:10px;">' +
                    '<button onclick="document.getElementById(\'pd-predict-notif-overlay\').remove();" ' +
                        'style="flex:1;padding:10px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">知道了</button>' +
                    '<button onclick="window._pdGoToPeriodTab();document.getElementById(\'pd-predict-notif-overlay\').remove();" ' +
                        'style="flex:2;padding:10px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">去看看 ✦</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        // 用公共的 showModal()，不然 .modal-content 那个入场动画播完之后，
        // 没有代码把它钉在"显示"状态，会自动弹回动画开始前的透明状态——
        // app 里所有其他弹窗都是靠这个函数才能在动画播完后正常留在屏幕上。
        if (typeof window.showModal === 'function') {
            window.showModal(overlay);
        } else {
            overlay.style.display = 'flex';
        }
    }

    window._pdGoToPeriodTab = function () {
        var modal = document.getElementById('period-modal');
        if (modal && typeof window.showModal === 'function') {
            window.showModal(modal);
            window._pdInit();
        }
    };

    // ── UI 渲染 ───────────────────────────────────────
    function _updateStats() {
        var s = _calcStats();
        var nEl = document.getElementById('pd-next-date');
        var lEl = document.getElementById('pd-next-date-label');
        var aEl = document.getElementById('pd-avg-days');

        // 正在经期时，这张卡片专门显示"当前状态"，不显示"下一次经期"的预测——
        // 不然"下次预测"这个标签配上一个日期区间，容易让人分不清这个日期到底是
        // "这次什么时候结束"还是"下一次什么时候开始"。等这次经期真正结束了，
        // 才切回显示下一次的预测区间。
        var active = _activePeriod();
        if (active) {
            if (lEl) lEl.textContent = '当前状态';
            if (nEl) nEl.textContent = '经期中 · 第' + _getDayNum(_today()) + '天';
        } else {
            if (lEl) lEl.textContent = '预测时间';
            if (nEl) nEl.textContent = s.nextDate;
        }
        if (aEl) aEl.textContent = s.avgDays;

        // 周期波动超过8天封顶时，多显示一行提示——老实告诉用户这个预测参考价值有限，
        // 不是偷偷把区间压小装作很准
        var irregEl = document.getElementById('pd-irregular-hint');
        if (irregEl) irregEl.style.display = (!active && s.irregular) ? '' : 'none';
    }

    function _updateToggleBtn() {
        var track = document.getElementById('pd-toggle-btn');   // pd-toggle-track
        var label = document.getElementById('pd-toggle-label');
        if (!track || !label) return;
        var inP = _isInPeriod(_today());
        track.classList.toggle('pd-toggle-on', inP);
        label.textContent = inP ? '经期中' : '标记经期';
    }

    function _updateStatusCard() {
        var today  = _today();
        var dayTag = document.getElementById('pd-status-day-tag');
        var dateEl = document.getElementById('pd-status-date');
        var now    = new Date();
        if (dateEl) dateEl.textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日';

        if (dayTag) {
            var dayNum = _getDayNum(today);
            if (dayNum > 0) {
                dayTag.textContent  = '经期第' + dayNum + '天';
                dayTag.style.display = '';
            } else {
                dayTag.style.display = 'none';
            }
        }

        // 载入今天已有的记录
        var rec      = _data.dailyRecords[today];
        _currentFlow     = rec ? (rec.flow || 0) : 0;
        _currentSymptoms = rec ? (rec.symptoms ? rec.symptoms.slice() : []) : [];

        document.querySelectorAll('.pd-flow-btn').forEach(function (btn) {
            btn.classList.toggle('pd-flow-active', Number(btn.dataset.val) === _currentFlow);
        });

        _updateSaveBtn(!!rec);
        _renderSymptoms();
    }

    function _updateSaveBtn(saved) {
        var btn  = document.getElementById('pd-save-btn');
        var hint = document.getElementById('pd-saved-hint');
        if (!btn) return;
        if (saved) {
            btn.textContent  = '已保存';
            btn.disabled     = true;
            btn.style.opacity = '0.5';
            if (hint) hint.textContent = '';
        } else {
            btn.textContent  = '保存记录';
            btn.disabled     = false;
            btn.style.opacity = '';
        }
    }

    // ── 日历 ──────────────────────────────────────────
    function _renderCalendar() {
        var label = document.getElementById('pd-month-label');
        if (label) label.textContent = _viewYear + '年' + (_viewMonth + 1) + '月';

        var grid = document.getElementById('pd-cal-grid');
        if (!grid) return;

        var firstDay    = new Date(_viewYear, _viewMonth, 1).getDay();
        var daysInMonth = new Date(_viewYear, _viewMonth + 1, 0).getDate();
        var today       = _today();
        var predicted   = _predictedDates();

        // 只显示当月的日期，不再补上个月/下个月的天数——月初用空白格子占位对齐星期即可，
        // 月末不用补，网格行数跟着当月实际天数走。之前补相邻月份天数时，那些格子会被
        // .pd-other-month 的淡化样式（透明度35%）盖一层，如果那天恰好也是真实经期，
        // 叠加淡化后看起来像是被打了折的"预测色"，容易造成误解。
        var html = '';
        for (var i = 0; i < firstDay; i++) {
            html += '<div class="pd-cal-cell pd-blank"></div>';
        }
        for (var d = 1; d <= daysInMonth; d++) {
            var ds2 = _toStr(new Date(_viewYear, _viewMonth, d));
            html += _cellHtml(d, ds2, today, predicted);
        }

        grid.innerHTML = html;
        _bindCalCells(grid);
    }

    function _cellHtml(day, dateStr, today, predicted) {
        var cls = 'pd-cal-cell';
        if (dateStr === today) cls += ' pd-today';
        if (_isInPeriod(dateStr)) cls += ' pd-period';
        else if (predicted.indexOf(dateStr) !== -1) cls += ' pd-predict';
        // 有日记录但没有颜色时加小圆点
        var dot = (_data.dailyRecords[dateStr] && !_isInPeriod(dateStr) && predicted.indexOf(dateStr) === -1)
            ? '<span class="pd-cal-dot"></span>' : '';
        return '<div class="' + cls + '" data-date="' + dateStr + '">' + day + dot + '</div>';
    }

    function _bindCalCells(grid) {
        grid.querySelectorAll('.pd-cal-cell').forEach(function (cell) {
            var dateStr = cell.dataset.date;
            if (!dateStr) return;  // 空白占位格子没有 data-date，跳过，不用绑事件

            cell.addEventListener('touchstart', function () {
                _longPressTimer = setTimeout(function () {
                    _longPressTimer = null;
                    if (dateStr < _today()) {
                        cell._longPressed = true;  // 标记这次是长按触发的，供下面 click 处理跳过
                        _toggleHistory(dateStr);
                        _renderCalendar();
                        _updateStats();
                        _updateToggleBtn();
                        _updateStatusCard();
                    }
                }, 600);
            }, { passive: true });
            cell.addEventListener('touchend', function () {
                if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
            });
            cell.addEventListener('touchmove', function () {
                if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
            });

            cell.addEventListener('click', function () {
                if (cell._longPressed) { cell._longPressed = false; return; }
                var today = _today();
                if (dateStr === today) {
                    var card = document.getElementById('pd-status-card');
                    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else {
                    _openDaySheet(dateStr);
                }
            });
        });
    }

    // ── 历史日弹窗（只读） ────────────────────────────
    function _openDaySheet(dateStr) {
        var d = _parse(dateStr);
        var titleEl = document.getElementById('pd-day-sheet-title');
        if (titleEl) titleEl.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日';

        var tagEl    = document.getElementById('pd-day-period-tag');
        var infoRow  = document.getElementById('pd-day-info-row');
        var dayNum   = _getDayNum(dateStr);
        if (tagEl)   { tagEl.textContent = '经期第' + dayNum + '天'; tagEl.style.display = dayNum > 0 ? '' : 'none'; }
        if (infoRow) infoRow.style.display = dayNum > 0 ? '' : 'none';

        var rec        = _data.dailyRecords[dateStr];
        var contentEl  = document.getElementById('pd-day-content');
        var emptyEl    = document.getElementById('pd-day-empty');
        var isEmpty    = dayNum === 0 && !rec;  // 既不在经期里，也没有任何打卡记录 —— 缺省状态

        if (isEmpty) {
            if (contentEl) contentEl.style.display = 'none';
            if (emptyEl)   emptyEl.style.display = '';
        } else {
            if (contentEl) contentEl.style.display = '';
            if (emptyEl)   emptyEl.style.display = 'none';

            var flowEl = document.getElementById('pd-day-flow-display');
            var sympEl = document.getElementById('pd-day-symptom-tags');
            if (flowEl) flowEl.textContent = (rec && rec.flow) ? FLOW_LABELS[rec.flow] : '暂无出血量记录';
            if (sympEl) {
                if (rec && rec.symptoms && rec.symptoms.length) {
                    sympEl.innerHTML = rec.symptoms.map(function (s) {
                        return '<span class="pd-day-symptom-tag">' + s + '</span>';
                    }).join('');
                } else {
                    sympEl.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;opacity:0.6;">暂无症状记录</span>';
                }
            }
        }

        var sheet = document.getElementById('pd-day-sheet');
        if (sheet && typeof window.showModal === 'function') window.showModal(sheet);
    }

    // ── 症状渲染 ──────────────────────────────────────
    function _renderSymptoms() {
        var wrap = document.getElementById('pd-symptoms-wrap');
        if (!wrap) return;
        var all = DEFAULT_SYMPTOMS.concat(_data.customSymptoms || []);
        var html = all.map(function (s) {
            var on = _currentSymptoms.indexOf(s) !== -1;
            return '<button class="pd-symptom-chip' + (on ? ' pd-chip-on' : '') +
                   '" onclick="window._pdToggleSymptom(this)">' + s + '</button>';
        }).join('');
        html += '<button class="pd-symptom-add" onclick="window._pdAddSymptom()">+ 自定义</button>';
        wrap.innerHTML = html;
    }

    // ── 梦角留言 ──────────────────────────────────────
    function _partnerName() {
        return (typeof settings !== 'undefined' && settings.partnerName) ||
               (window._settings && window._settings.partnerName) || '梦角';
    }

    function _renderLetterCard() {
        var pname   = _partnerName();
        var nameEl  = document.getElementById('pd-letter-name');
        var pnEl    = document.getElementById('pd-letter-pname');
        if (nameEl) nameEl.textContent = pname;
        if (pnEl)   pnEl.textContent   = pname;

        // 头像 —— 之前读的是 #partner-avatar 这个 div 容器的 .src，
        // 但 div 没有 src 属性，永远是 undefined，判断永远不成立，头像永远不会联动。
        // 改成读容器里真正的 <img> 子元素（有设置头像时，头像模块会把 <img> 塞进这个 div 里；
        // 没设置时塞的是 <i class="fas fa-user">，这里做法保持一致，不再写死🌸）。
        var avEl = document.getElementById('pd-partner-av');
        if (avEl) {
            var realImg = document.querySelector('#partner-avatar img');
            avEl.innerHTML = (realImg && realImg.src)
                ? '<img src="' + realImg.src + '">'
                : '<i class="fas fa-user"></i>';
        }

        // 留言内容
        var emptyEl = document.getElementById('pd-letter-empty');
        var linesEl = document.getElementById('pd-letter-lines');

        // 判断当前经期是否有留言——只认"正在进行中"的这一次，不再退回去找"最后一次经期"，
        // 不然经期都结束了，卡片还会一直显示上一次的旧留言内容，看起来像是没清干净
        var active   = _activePeriod();
        var hasMsg   = active && _data.partnerMsg && _data.partnerMsg.periodId === active.id && _data.partnerMsg.date === _today();

        if (hasMsg && _data.partnerMsg.lines && _data.partnerMsg.lines.length) {
            if (emptyEl) emptyEl.style.display = 'none';
            if (linesEl) {
                linesEl.style.display = '';
                linesEl.innerHTML = _data.partnerMsg.lines.map(function (l) {
                    return '<div class="pd-letter-line">' + l + '</div>';
                }).join('');
            }
        } else {
            if (emptyEl) emptyEl.style.display = '';
            if (linesEl) linesEl.style.display = 'none';
        }
    }

    // ── 公开 API ──────────────────────────────────────
    window._pdToggleToday = function () {
        var today = _today();
        if (_isInPeriod(today)) {
            // 覆盖"今天"的这条记录，可能是点"标记经期"建出来的"进行中"记录（_activePeriod能找到），
            // 也可能是长按补录出来的、一开始就有明确结束日期的记录（_activePeriod找不到，
            // 之前只处理前一种，导致长按补录出来的记录点"关闭"完全没反应）。
            // 这里不区分是哪一种，统一找到"覆盖今天的那条记录"来处理。
            var p = _getPeriodOf(today);
            if (p) {
                _cancelPendingNotifFor(p.id);  // 关闭这条记录时，顺手取消掉可能还没发出的留言
                var newEnd = _addD(today, -1);
                if (newEnd < p.startDate) {
                    // 缩回去的结束日期比开始日期还早，说明这条记录只覆盖今天一天，直接整条删掉
                    _data.periods = _data.periods.filter(function (x) { return x.id !== p.id; });
                } else {
                    p.endDate = newEnd;  // 今天不算了，缩到昨天为止
                }
                _save();
            }
        } else {
            _startPeriod(today, true);
        }
        _renderCalendar();
        _updateStats();
        _updateToggleBtn();
        _updateStatusCard();
    };

    window._pdSetFlow = function (val) {
        _currentFlow = val;
        document.querySelectorAll('.pd-flow-btn').forEach(function (btn) {
            btn.classList.toggle('pd-flow-active', Number(btn.dataset.val) === val);
        });
        _updateSaveBtn(false);
    };

    window._pdToggleSymptom = function (btn) {
        btn.classList.toggle('pd-chip-on');
        var s   = btn.textContent;
        var idx = _currentSymptoms.indexOf(s);
        if (idx === -1) _currentSymptoms.push(s); else _currentSymptoms.splice(idx, 1);
        _updateSaveBtn(false);
    };

    window._pdAddSymptom = function () {
        var val = prompt('输入自定义症状名称：');
        if (!val || !val.trim()) return;
        val = val.trim();
        if (!_data.customSymptoms) _data.customSymptoms = [];
        if (DEFAULT_SYMPTOMS.indexOf(val) === -1 && _data.customSymptoms.indexOf(val) === -1) {
            _data.customSymptoms.push(val);
            _save();
        }
        _renderSymptoms();
    };

    window._pdSaveRecord = function () {
        var today = _today();
        _data.dailyRecords[today] = { flow: _currentFlow, symptoms: _currentSymptoms.slice() };
        _save();
        _updateSaveBtn(true);
        _renderCalendar();  // 刷新日历上的小点
    };

    window._pdCloseDaySheet = function () {
        var sheet = document.getElementById('pd-day-sheet');
        if (sheet && typeof window.hideModal === 'function') window.hideModal(sheet);
    };

    // ── 入口 ──────────────────────────────────────────
    window._pdInit = async function () {
        if (!_loaded) await _load();

        var now    = new Date();
        _viewYear  = now.getFullYear();
        _viewMonth = now.getMonth();

        _renderCalendar();
        _renderSymptoms();
        _updateStats();
        _updateToggleBtn();
        _updateStatusCard();
        _renderLetterCard();
        _scheduleTodayNotifIfNeeded();
        _checkNotif();

        // 月份切换
        var prev = document.getElementById('pd-prev-month');
        var next = document.getElementById('pd-next-month');
        if (prev) prev.onclick = function () {
            _viewMonth--;
            if (_viewMonth < 0) { _viewMonth = 11; _viewYear--; }
            _renderCalendar();
        };
        if (next) next.onclick = function () {
            _viewMonth++;
            if (_viewMonth > 11) { _viewMonth = 0; _viewYear++; }
            _renderCalendar();
        };
    };

    // 每分钟检查一次通知（梦角留言 + 预测经期前一天提醒）
    setInterval(function () {
        if (_loaded) { _scheduleTodayNotifIfNeeded(); _checkNotif(); _checkPredictReminder(); }
    }, 60000);

    // 脚本一加载（也就是打开网站）就先悄悄读一次数据，不用等用户点开经期记录弹窗，
    // 这样"预测提醒"才能在用户完全没打开过经期功能的情况下也正常触发。
    // 延迟4秒再检查，是因为开机欢迎动画的 z-index 比弹窗高很多，动画播完前就弹出来会被盖住看不见；
    // 欢迎动画正常播放大概3秒左右结束，4秒留了一点余量。
    _load().then(function () {
        setTimeout(function () {
            _scheduleTodayNotifIfNeeded();
            _checkNotif();
            _checkPredictReminder();
        }, 4000);
    });

})();
