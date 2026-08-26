/**
 * survey.js — 调查问卷功能
 *
 * Step 1：数据结构 + 创建问卷弹窗（我问梦角）+ 聊天设置→节奏tab 问卷回复时间滑块
 * Step 2：梦角选择算法 + 提醒机制 + 历史记录列表页 + 详情页（我问梦角完整闭环）
 * Step 3（这一步做的）：反向问卷（梦角问我）+ 回复库"问卷题库"tab + 触发引擎 + 回收站
 *
 * 数据结构（_data）：
 * {
 *   askPartner: [
 *     {
 *       id, createdAt, dueAt,                 // dueAt = 倒计时结束时间点，到点才真正"算"梦角选了什么
 *       status: 'pending' | 'answered' | 'withdrawn',
 *       answeredAt, deletedAt,
 *       viewed: bool,             // 仅 status==='answered' 时有意义：到点变answered时置false（角标显示"new"），
 *                                  // 用户点开详情页那一刻置true（角标变"已回复"）
 *       favorited: bool,          // 收藏——只有 status==='answered' 时才允许收藏
 *       selections: null | { [questionId]: [optionId, ...] },  // 倒计时结束那一刻才算，之前一直是 null
 *       questions: [
 *         { id, type: 'single'|'multi', text, options: [ { id, kind:'text'|'image', value } ] }
 *       ]
 *     }, ...
 *   ],
 *   askMe: [                     // 反向问卷（梦角问我）
 *     {
 *       id, sentAt, status: 'sent' | 'answered_pending' | 'received', receivedAt, deletedAt,
 *       viewed: bool,             // 仅 status==='sent' 时有意义：生成时置false（角标显示"new"），
 *                                  // 用户点开详情页那一刻置true（角标变"未回答"）
 *       favorited: bool,          // 收藏——status==='answered_pending' 或 'received' 时才允许收藏
 *       answeredAt,               // 用户提交回答的时间点（status变answered_pending那一刻）
 *       receiveDueAt,             // 提交后随机2-5小时算出的"梦角看到"时间点，到点才变成 received
 *       answers: null | { [questionId]: answerText },
 *       questions: [ { id, text } ]   // 纯文字开放式提问，没有选项
 *     }, ...
 *   ],
 *   bank: [                      // 反向问卷题库（回复库→氛围感→"问卷题库"tab 管理）
 *     { id, text, builtin: bool, hidden: bool, drawCount: number, groupId: null|string }
 *     // drawCount：这道题被抽中过几次——抽题永远优先抽 drawCount 最小的那一档，
 *     // 抽过的 +1，不再用"用没用过"的是非标记（那种判法在题库刚好抽完一轮的边界上有概率重复）
 *   ],
 *   bankGroups: [                // 题库分组——交互对齐主字卡的"字卡分组"（新建/编辑/删除、筛选胶囊），
 *                                 // 但数据结构反过来：不是分组记着自己有哪些题（按文字匹配，容易重名撞车），
 *                                 // 而是每道题自己记着 groupId，用id对应更稳
 *     { id, name, color, disabled: bool }
 *   ],
 *   bankDefaultGroupSeeded: bool, // 是否已经自动创建过"默认问题"这个分组——只在第一次种一次，
 *                                  // 用户之后删了就不会再自动冒出来
 *   askMeTrigger: { nextCheckAt: timestamp, missStreak: 0|1|2+ },
 *     // 触发概率：missStreak 0→50%，1→80%，2+→100%；中了清零；每次检查后不管中没中都重排 5-8 天后的 nextCheckAt
 *   replyDelayMinHours: 1,       // 问卷回复时间区间（小时），聊天设置→节奏tab 那两个新滑块
 *   replyDelayMaxHours: 24
 * }
 *
 * 存储 key 的取法完全照抄 period.js 那一套（localforage.keys() 扫描 + 等 SESSION_ID 就绪），
 * 理由和坑点跟经期记录一模一样，不再重复注释。
 */
(function () {
    'use strict';

    var _data = { askPartner: [], askMe: [], replyDelayMinHours: 1, replyDelayMaxHours: 24 };
    var _loaded = false;
    var _storageKey = null;

    // 创建问卷弹窗的临时编辑态（还没点"发送"之前，都存在这里，跟 _data 完全分开）
    var _draftQuestions = [];
    // 非 null 时表示当前是"编辑已有问卷"，值是那份问卷的 id——
    // 编辑态下弹窗复用同一套渲染，但要锁掉"加题/删题/改单多选"这三个操作
    var _editingSurveyId = null;

    // ── Storage（照抄 period.js 的取key方式） ──────────────────────
    async function _getKey() {
        if (_storageKey) return _storageKey;
        var properKey = null;
        try {
            if (typeof SESSION_ID !== 'undefined' && SESSION_ID && typeof window.getStorageKey === 'function') {
                properKey = window.getStorageKey('surveyData');
            }
        } catch (e) { /* SESSION_ID 可能还没初始化 */ }
        if (properKey) { _storageKey = properKey; return properKey; }
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_surveyData') !== -1; });
            if (found) return found;
            var msgKey = allKeys.find(function (k) { return k.indexOf('_chatMessages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_chatMessages', '') : 'CHAT_APP_V3_';
            return prefix + '_surveyData';
        } catch (e) {
            return 'CHAT_APP_V3__surveyData';
        }
    }

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
            if (saved) {
                _data = saved;
                if (!Array.isArray(_data.askPartner)) _data.askPartner = [];
                if (!Array.isArray(_data.askMe)) _data.askMe = [];
                if (!_data.replyDelayMinHours) _data.replyDelayMinHours = 1;
                if (!_data.replyDelayMaxHours) _data.replyDelayMaxHours = 24;
                // 兼容 Step 1 时创建的旧数据（那会儿还没有 deletedAt 字段）
                _data.askPartner.forEach(function (s) { if (s.deletedAt === undefined) s.deletedAt = null; });
                _data.askMe.forEach(function (s) { if (s.deletedAt === undefined) s.deletedAt = null; });
                // 兼容"已读/未读角标"上线前的旧数据：老记录一律当成"已经看过"，
                // 避免一上线一大批老问卷全变成"new"炸用户一脸
                _data.askPartner.forEach(function (s) { if (s.viewed === undefined) s.viewed = true; });
                _data.askMe.forEach(function (s) {
                    if (s.viewed === undefined) s.viewed = true;
                    // 老数据的 status 只有 'sent'/'received' 两种，'received' 直接映射成新的最终态即可，不用改名
                });
                // 兼容"收藏"上线前的旧数据
                _data.askPartner.forEach(function (s) { if (s.favorited === undefined) s.favorited = false; });
                _data.askMe.forEach(function (s) { if (s.favorited === undefined) s.favorited = false; });
            }
        } catch (e) { console.warn('[survey] load failed:', e); }
        if (!Array.isArray(_data.bank) || !_data.bank.length) _seedBuiltinBank();
        _ensureDefaultBankGroup();
        if (!_data.askMeTrigger) {
            _data.askMeTrigger = { nextCheckAt: Date.now() + _randDays(5, 8), missStreak: 0 };
        }
        _loaded = true;
        _syncDelaySlidersUI();
    }

    async function _save() {
        try {
            var key = await _getKey();
            await localforage.setItem(key, _data);
        } catch (e) { console.warn('[survey] save failed:', e); }
    }

    function _uid(prefix) {
        return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    function _randDays(a, b) { return (a + Math.random() * (b - a)) * 86400000; }

    // ── 反向问卷（梦角问我）内置题库，60条，感情/生活习惯/未来展望各20 ──
    var BUILTIN_BANK_TEXTS = [
        '你生气的时候希望我哄你还是让你静一静', '你难过的时候想让我抱你还是陪你说话', '你跟我吵架的时候最怕我说什么',
        '你希望我吃醋还是不吃的醋', '你喜欢惊喜还是提前商量', '你最喜欢我碰你哪里',
        '你睡觉的时候希望我抱着你还是各自睡', '你早上醒来第一件事会想我吗', '你希望每天说晚安吗',
        '你怎么表达"我想你了"', '你什么时候会主动牵我的手', '你会因为什么小事突然对我心动',
        '你最喜欢我叫你什么', '你会因为我的哪句话开心一整天', '你心里有没有一个"理想伴侣"的样子，我像吗',
        '你觉得我们之间最默契的地方是什么', '你希望我怎么对待你的朋友', '你有没有幻想过我们结婚的场景',
        '你更想要浪漫还是实用', '你希望我用什么方式告诉你我爱你',
        '你刷牙用冷水还是温水', '你睡觉喜欢朝左还是朝右', '你吃饭时先吃菜还是先吃饭',
        '你洗澡的时候会唱歌吗', '你挤牙膏从中间挤还是从尾巴挤', '你吃饺子蘸醋还是蘸酱油',
        '你睡觉抱东西吗', '你喜欢穿拖鞋还是光脚', '你吃西瓜用勺子还是切块',
        '你喜欢淋浴还是泡澡', '你喝咖啡加糖吗', '你吃薯条蘸番茄酱还是冰淇淋',
        '你煮泡面会加鸡蛋吗', '你吃苹果削皮吗', '你喜欢开灯睡觉还是全黑',
        '你吃炸鸡先吃皮还是先吃肉', '你喝汤会端起碗喝还是用勺子', '你吃巧克力会咬还是含',
        '你系鞋带是蝴蝶结还是单结', '你喝牛奶会舔嘴角吗',
        '我们以后会住在一起吗', '以后家里你想养猫还是狗', '你想过结婚吗',
        '孩子像你还是像我', '十年后我们还会一起吃饭吗', '我们以后每年都去旅行好不好',
        '你以后还会像现在这样对我好吗', '下辈子你还想遇到我吗', '你以后会记得我们的纪念日吗',
        '我想多了解你一点', '你小时候发生过什么有趣的事吗', '你最喜欢的颜色是什么',
        '你小时候的梦想是什么', '你最开心的一次回忆是什么', '你最喜欢吃什么',
        '你喜欢什么样的天气', '你最喜欢的一首歌是什么', '你从什么时候开始喜欢我的',
        '你最喜欢我哪一点', '你希望我们变成什么样子'
    ];

    function _seedBuiltinBank() {
        var existing = Array.isArray(_data.bank) ? _data.bank : [];
        // 万一之前已经有自定义题（理论上现在不会，但留个防御），种子只补内置的，不覆盖已有数据
        var already = new Set(existing.filter(function (q) { return q.builtin; }).map(function (q) { return q.text; }));
        BUILTIN_BANK_TEXTS.forEach(function (t, i) {
            if (already.has(t)) return;
            existing.push({ id: 'bk_' + i, text: t, builtin: true, hidden: false, drawCount: 0, groupId: undefined });
        });
        _data.bank = existing;
    }

    // 题库分组：内置题第一次加载时统一塞进一个叫"默认问题"的分组，跟主字卡的"字卡分组"
    // 是同一套交互（新建/编辑/删除分组、把题目分到不同组），但数据结构不一样——主字卡是
    // "分组记着自己有哪些内容(items数组，按文字匹配)"，这里反过来是"每道题记着自己属于哪个
    // 分组(groupId)"，用id对应，不怕两条题目文字凑巧写重复
    function _ensureDefaultBankGroup() {
        if (!Array.isArray(_data.bankGroups)) _data.bankGroups = [];
        // 只在"从来没种过默认分组"这一次自动创建+把内置题挂上去；之后哪怕用户把这个分组删了，
        // 也不会又冒出来一个——跟主字卡分组一样，删了就是删了，不会硬塞回来
        if (!_data.bankDefaultGroupSeeded) {
            var defaultGroup = { id: _uid('bg'), name: '默认问题', color: '#748FFC', disabled: false };
            _data.bankGroups.unshift(defaultGroup);
            _data.bank.forEach(function (item) { if (item.builtin) item.groupId = defaultGroup.id; });
            _data.bankDefaultGroupSeeded = true;
        }
        _data.bank.forEach(function (item) { if (item.groupId === undefined) item.groupId = null; });
    }

    // ── 问卷回复时间滑块（聊天设置→节奏tab）──────────────────────
    // 这两个滑块的值不进全局 settings 对象，单独存在 _data 里、单独绑定事件，
    // 不碰 core.js 里主聊天回复速度那套逻辑，两边完全独立
    function _syncDelaySlidersUI() {
        var minSlider = document.getElementById('survey-delay-min-slider');
        var maxSlider = document.getElementById('survey-delay-max-slider');
        var minVal = document.getElementById('survey-delay-min-value');
        var maxVal = document.getElementById('survey-delay-max-value');
        if (minSlider) minSlider.value = _data.replyDelayMinHours;
        if (maxSlider) maxSlider.value = _data.replyDelayMaxHours;
        if (minVal) minVal.textContent = _data.replyDelayMinHours + 'h';
        if (maxVal) maxVal.textContent = _data.replyDelayMaxHours + 'h';
        if (minSlider && maxSlider) maxSlider.min = minSlider.value;
    }

    function _bindDelaySliders() {
        var minSlider = document.getElementById('survey-delay-min-slider');
        var maxSlider = document.getElementById('survey-delay-max-slider');
        if (!minSlider || !maxSlider) return;
        minSlider.addEventListener('input', function () {
            var minVal = document.getElementById('survey-delay-min-value');
            if (minVal) minVal.textContent = minSlider.value + 'h';
            if (+minSlider.value > +maxSlider.value) {
                maxSlider.value = minSlider.value;
                var maxVal = document.getElementById('survey-delay-max-value');
                if (maxVal) maxVal.textContent = maxSlider.value + 'h';
            }
            maxSlider.min = minSlider.value;
        });
        minSlider.addEventListener('change', function () {
            _data.replyDelayMinHours = +minSlider.value;
            if (_data.replyDelayMinHours > _data.replyDelayMaxHours) _data.replyDelayMaxHours = _data.replyDelayMinHours;
            _save();
        });
        maxSlider.addEventListener('input', function () {
            var maxVal = document.getElementById('survey-delay-max-value');
            if (maxVal) maxVal.textContent = maxSlider.value + 'h';
        });
        maxSlider.addEventListener('change', function () {
            _data.replyDelayMaxHours = +maxSlider.value;
            _save();
        });
    }

    // ── 创建问卷弹窗：草稿态问题结构 ──────────────────────────────
    function _newDraftQuestion() {
        return {
            id: _uid('q'),
            type: 'single',
            text: '',
            optKind: 'text', // 同题内类型不混用，这个是"这道题的选项统一是文字还是图片"
            options: [
                { id: _uid('o'), value: '' },
                { id: _uid('o'), value: '' }
            ]
        };
    }

    function _openCreateModal(editSurvey) {
        var titleEl = document.querySelector('#survey-create-modal .modal-title span');
        var addQBtn = document.getElementById('survey-add-q-btn');
        if (editSurvey) {
            _editingSurveyId = editSurvey.id;
            // 深拷贝一份出来编辑，不直接改原对象，点"取消"就什么都没发生过
            _draftQuestions = editSurvey.questions.map(function (q) {
                return {
                    id: q.id, type: q.type, text: q.text, optKind: q.options[0] ? q.options[0].kind : 'text',
                    options: q.options.map(function (o) { return { id: o.id, value: o.value }; })
                };
            });
            if (titleEl) titleEl.textContent = '编辑问卷';
            if (addQBtn) addQBtn.style.display = 'none';
        } else {
            _editingSurveyId = null;
            _draftQuestions = [_newDraftQuestion()];
            if (titleEl) titleEl.textContent = '创建问卷';
            if (addQBtn) addQBtn.style.display = '';
        }
        _renderDraftQuestions();
        if (typeof window.showModal === 'function') {
            window.showModal(document.getElementById('survey-create-modal'));
        } else {
            document.getElementById('survey-create-modal').style.display = 'flex';
        }
    }

    function _closeCreateModal() {
        _editingSurveyId = null;
        if (typeof window.hideModal === 'function') {
            window.hideModal(document.getElementById('survey-create-modal'));
        } else {
            document.getElementById('survey-create-modal').style.display = 'none';
        }
    }

    // 校验：至少1个问题，每题至少2个选项（不管文字还是图片，都要求"有内容"才算数）
    function _validateDraft() {
        if (!_draftQuestions.length) return false;
        return _draftQuestions.every(function (q) {
            if (!q.options || q.options.length < 2) return false;
            return q.options.every(function (o) {
                return o.kind === 'image' ? !!o.value : (o.value && o.value.trim());
            });
        });
    }

    function _updateSendBtnState() {
        var btn = document.getElementById('survey-create-send');
        if (btn) btn.disabled = !_validateDraft();
    }

    function _renderDraftQuestions() {
        var list = document.getElementById('survey-q-list');
        if (!list) return;
        list.innerHTML = '';
        _draftQuestions.forEach(function (q, qIdx) {
            list.appendChild(_buildQuestionCard(q, qIdx));
        });
        _updateSendBtnState();
    }

    function _buildQuestionCard(q, qIdx) {
        var card = document.createElement('div');
        card.className = 'survey-q-card';
        card.dataset.qid = q.id;

        var hd = document.createElement('div');
        hd.className = 'survey-q-card-hd';
        hd.innerHTML = '<span class="survey-q-index">Q' + (qIdx + 1) + '</span>';
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'survey-q-del-btn';
        delBtn.innerHTML = '<i class="fas fa-times"></i>';
        delBtn.onclick = function () {
            _draftQuestions = _draftQuestions.filter(function (x) { return x.id !== q.id; });
            _renderDraftQuestions();
        };
        // 编辑模式下不能加题删题——整个删除按钮都不显示；创建模式下只有多于1题时才能删
        delBtn.style.visibility = (!_editingSurveyId && _draftQuestions.length > 1) ? 'visible' : 'hidden';
        hd.appendChild(delBtn);
        card.appendChild(hd);

        var textInput = document.createElement('textarea');
        textInput.className = 'survey-q-text-input';
        textInput.placeholder = '问题内容';
        textInput.value = q.text;
        textInput.rows = 1;
        textInput.oninput = function () { q.text = textInput.value; };
        card.appendChild(textInput);

        var typeToggle = document.createElement('div');
        typeToggle.className = 'survey-type-toggle';
        ['single', 'multi'].forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'survey-type-btn' + (q.type === t ? ' active' : '');
            b.textContent = t === 'single' ? '单选' : '多选';
            if (_editingSurveyId) {
                // 编辑模式下不能改单选/多选——按钮还看得见（保留视觉一致性），但点了没反应
                b.disabled = true;
                b.style.opacity = (q.type === t) ? '1' : '0.4';
                b.style.cursor = 'default';
            } else {
                b.onclick = function () {
                    q.type = t;
                    _renderDraftQuestions();
                };
            }
            typeToggle.appendChild(b);
        });
        card.appendChild(typeToggle);

        var kindToggle = document.createElement('div');
        kindToggle.className = 'survey-q-kind-toggle';
        [['text', '文字选项'], ['image', '图片选项']].forEach(function (pair) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'survey-q-kind-btn' + (q.optKind === pair[0] ? ' active' : '');
            b.textContent = pair[1];
            if (_editingSurveyId) {
                // 编辑模式下同样锁掉——只让改"内容"，选项是文字还是图片这个类型不算内容
                b.disabled = true;
                b.style.opacity = (q.optKind === pair[0]) ? '1' : '0.4';
                b.style.cursor = 'default';
            } else {
                b.onclick = function () {
                    if (q.optKind === pair[0]) return;
                    q.optKind = pair[0];
                    // 切类型清空已填的内容——文字和图片的 value 含义不一样，混着留没意义，
                    // 而且用户是主动点切换的，清空不算意外丢数据
                    q.options.forEach(function (o) { o.value = ''; });
                    _renderDraftQuestions();
                };
            }
            kindToggle.appendChild(b);
        });
        card.appendChild(kindToggle);

        var optList = document.createElement('div');
        optList.className = 'survey-option-list';
        q.options.forEach(function (opt, oIdx) {
            optList.appendChild(_buildOptionRow(q, opt, oIdx));
        });
        card.appendChild(optList);

        var addOptBtn = document.createElement('button');
        addOptBtn.type = 'button';
        addOptBtn.className = 'survey-add-option-btn';
        addOptBtn.innerHTML = '<i class="fas fa-plus"></i> 添加选项';
        addOptBtn.disabled = q.options.length >= 10;
        addOptBtn.onclick = function () {
            if (q.options.length >= 10) return;
            q.options.push({ id: _uid('o'), value: '' });
            _renderDraftQuestions();
        };
        card.appendChild(addOptBtn);

        return card;
    }

    function _buildOptionRow(q, opt, oIdx) {
        var row = document.createElement('div');
        row.className = 'survey-option-row';

        if (q.optKind === 'image') {
            var wrap = document.createElement('div');
            wrap.className = 'survey-option-img-wrap';
            var thumb = document.createElement('div');
            thumb.className = 'survey-option-img-thumb';
            // opt.value 可能是本地 base64（直接能当 src 用），也可能是已经传到云端后的 oss:// 引用
            // （这种要走 CloudMedia 懒加载解析成真正能显示的 blob URL，直接塞进 src 浏览器认不出协议，
            // 图裂了——之前这里就是漏了这一步，只是拿 opt.value 原样当 src 用）
            if (opt.value) {
                if (window.CloudMedia && window.CloudMedia.isCloudRef && window.CloudMedia.isCloudRef(opt.value)) {
                    var thumbImg = document.createElement('img');
                    thumb.innerHTML = '';
                    thumb.appendChild(thumbImg);
                    window.CloudMedia.bindLazyImage(thumbImg, opt.value);
                } else {
                    thumb.innerHTML = '<img src="' + opt.value + '">';
                }
            } else {
                thumb.innerHTML = '<i class="fas fa-image"></i>';
            }
            wrap.appendChild(thumb);

            var pickLabel = document.createElement('label');
            pickLabel.className = 'survey-option-img-pick';
            pickLabel.textContent = opt.value ? '换一张' : '选择图片';
            var fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';
            fileInput.onchange = function () {
                var file = fileInput.files && fileInput.files[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) {
                    showNotification && showNotification('图片不能超过2MB', 'error');
                    fileInput.value = '';
                    return;
                }
                var reader = new FileReader();
                reader.onload = function () {
                    opt.value = reader.result;
                    _renderDraftQuestions();
                };
                reader.readAsDataURL(file);
            };
            pickLabel.appendChild(fileInput);
            wrap.appendChild(pickLabel);
            row.appendChild(wrap);
        } else {
            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'survey-option-text-input';
            input.placeholder = '选项 ' + (oIdx + 1);
            input.value = opt.value;
            input.oninput = function () { opt.value = input.value; _updateSendBtnState(); };
            row.appendChild(input);
        }

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'survey-option-del-btn';
        delBtn.innerHTML = '<i class="fas fa-times"></i>';
        delBtn.style.visibility = q.options.length > 2 ? 'visible' : 'hidden';
        delBtn.onclick = function () {
            if (q.options.length <= 2) return;
            q.options = q.options.filter(function (x) { return x.id !== opt.id; });
            _renderDraftQuestions();
        };
        row.appendChild(delBtn);

        return row;
    }

    // ── 图片选项：本地存的是 base64，配置了 OSS 就在后台悄悄迁移成云端地址 ──
    // 跟聊天发图片那套"发送即成功、后台重试"共用同一个上传队列（CloudMedia.queueUpload），
    // 区别是问卷这边不用管"消息还没发出去"这种时序问题，直接迁移+存回本地数据就完事
    function _migrateOptionImagesToCloud(survey) {
        if (!(window.CloudMedia && window.CloudSync && window.CloudSync.isConnected())) return;
        survey.questions.forEach(function (q) {
            q.options.forEach(function (opt) {
                if (opt.kind === 'image' && typeof opt.value === 'string' && opt.value.indexOf('data:image') === 0) {
                    window.CloudMedia.queueUpload(opt.value, 'survey-options', {
                        onSuccess: function (result) {
                            opt.value = result.url;
                            _save();
                        }
                    });
                }
            });
        });
    }

    function _randomDueAt() {
        var minH = _data.replyDelayMinHours || 1;
        var maxH = Math.max(minH, _data.replyDelayMaxHours || 24);
        var hours = minH + Math.random() * (maxH - minH);
        return Date.now() + hours * 3600000;
    }

    function _submitCreate() {
        if (!_validateDraft()) return;
        var questionsPayload = _draftQuestions.map(function (q) {
            return {
                id: q.id,
                type: q.type,
                text: q.text.trim(),
                options: q.options.map(function (o) {
                    return { id: o.id, kind: q.optKind, value: o.value };
                })
            };
        });

        if (_editingSurveyId) {
            var target = _data.askPartner.find(function (s) { return s.id === _editingSurveyId; });
            if (!target) { _closeCreateModal(); return; }
            // 编辑不重置倒计时——dueAt/status/createdAt 都原样保留，只换题目内容
            target.questions = questionsPayload;
            _save();
            _migrateOptionImagesToCloud(target);
            _closeCreateModal();
            if (typeof showNotification === 'function') showNotification('问卷已更新', 'success');
            _refreshOpenViews();
        } else {
            var survey = {
                id: _uid('sv'),
                createdAt: Date.now(),
                dueAt: _randomDueAt(),
                status: 'pending',
                answeredAt: null,
                deletedAt: null,
                viewed: true,
                favorited: false,
                selections: null,
                questions: questionsPayload
            };
            _data.askPartner.push(survey);
            _save();
            _migrateOptionImagesToCloud(survey);
            _closeCreateModal();
            if (typeof showNotification === 'function') showNotification('问卷已发出，等待回复中', 'success');
            _refreshOpenViews();
        }
    }

    // ══════════════════════════════════════════════════════════════
    // Step 2：梦角选择算法 + 到点检查 + 提醒机制 + 历史列表/详情页
    // ══════════════════════════════════════════════════════════════

    // ── 梦角选择算法：单选等概率随机1个；多选先等概率随机决定选几个(1~选项总数)，
    //    再洗牌取前K个——保证不会出现"总是全选"或"总是只选1个"这种明显不公平的偏向 ──
    function _computeSelection(question) {
        var n = question.options.length;
        if (question.type === 'single') {
            var idx = Math.floor(Math.random() * n);
            return [question.options[idx].id];
        }
        var k = 1 + Math.floor(Math.random() * n); // 1 ~ n 等概率
        var shuffled = question.options.slice().sort(function () { return Math.random() - 0.5; });
        return shuffled.slice(0, k).map(function (o) { return o.id; });
    }

    // ── 到点检查：每分钟扫一次，倒计时到了才真正"算"梦角选了什么——
    //    编辑问卷不会重置这个 dueAt，所以编辑到最后一刻都是安全的 ──
    function _checkDueSurveys() {
        if (!_loaded) return;
        var now = Date.now();
        var newlyAnswered = [];
        _data.askPartner.forEach(function (s) {
            if (s.status === 'pending' && !s.deletedAt && s.dueAt && now >= s.dueAt) {
                var selections = {};
                s.questions.forEach(function (q) { selections[q.id] = _computeSelection(q); });
                s.selections = selections;
                s.status = 'answered';
                s.answeredAt = now;
                s.viewed = false; // 刚到点算出结果，角标先显示"new"，用户点开详情页之后才变"已回复"
                newlyAnswered.push(s);
            }
        });
        if (newlyAnswered.length) {
            _save();
            newlyAnswered.forEach(function (s) { _queueNotify({ type: 'answered', survey: s }); });
            _refreshOpenViews();
        }
    }

    // ══ 反向问卷（梦角问我）：触发引擎 + 抽题 + 提交回答 ══════════
    //
    // 触发概率：5-8天随机检查一次；上次触发过 → 这次50%；上次没中 → 这次80%；
    // 再没中 → 这次100%必中。中了就把 missStreak 清零，重新从50%开始下一轮计时。
    function _checkAskMeTrigger() {
        if (!_loaded) return;
        var t = _data.askMeTrigger;
        if (!t || Date.now() < t.nextCheckAt) return;

        var prob = t.missStreak === 0 ? 0.5 : (t.missStreak === 1 ? 0.8 : 1);
        var hit = Math.random() < prob;
        if (hit) {
            var batch = _createAskMeBatch();
            if (batch) {
                t.missStreak = 0;
                _queueNotify({ type: 'askme_new', survey: batch });
                _refreshOpenViews();
            }
            // 题库里没有可用题目（比如全被隐藏了）就当这次白抽，missStreak 不变，
            // 照样往下重新排一次 5-8 天后的检查时间，不会卡住
        } else {
            t.missStreak++;
        }
        t.nextCheckAt = Date.now() + _randDays(5, 8);
        _save();
    }

    // 抽题：不放回抽取，但不再用"用没用过"这种是非判断（那种判法在"题库刚好抽完一轮"
    // 的那一瞬间会有个漏洞——重置和抽新一批是同一次操作里前后脚发生的，导致上一批最后几道题
    // 跟下一批开头几道题有概率撞车）。改用"这道题被抽过几次"的计数器，永远优先抽计数最小的
    // 那一档，某一档抽完了自然顺延到下一档（第一轮全部是0，抽过的变1；等全部题目都至少被
    // 抽过一次、也就是最小计数变成1了，就在1这一档里继续抽，抽完了再顺延到2……一直滚动下去），
    // 不存在"某个瞬间突然集体清零"这种断层，天然不会出现题库边界处的重复
    function _createAskMeBatch() {
        var pool = _data.bank.filter(function (q) {
            if (q.hidden) return false;
            if (q.groupId) {
                var g = (_data.bankGroups || []).find(function (x) { return x.id === q.groupId; });
                if (g && g.disabled) return false; // 分组被屏蔽，组里的题目也一起不参与抽题
            }
            return true;
        });
        if (!pool.length) return null;
        pool.forEach(function (q) { if (typeof q.drawCount !== 'number') q.drawCount = 0; }); // 兼容老数据

        var kChoices = [3, 4, 5];
        var k = Math.min(kChoices[Math.floor(Math.random() * 3)], pool.length);

        // 按抽过的次数从低到高分档，档内随机打乱，从最低档开始一档一档取，凑够k个为止——
        // 这样低档的题目永远先被取完，绝不会出现"新一档的题还没轮到，旧一档的题就又被抽了一次"
        var byCount = {};
        pool.forEach(function (q) {
            (byCount[q.drawCount] = byCount[q.drawCount] || []).push(q);
        });
        var tiers = Object.keys(byCount).map(Number).sort(function (a, b) { return a - b; });
        var picked = [];
        for (var ti = 0; ti < tiers.length && picked.length < k; ti++) {
            var tierItems = byCount[tiers[ti]].slice().sort(function () { return Math.random() - 0.5; });
            var need = k - picked.length;
            picked = picked.concat(tierItems.slice(0, need));
        }
        picked.forEach(function (q) { q.drawCount = (q.drawCount || 0) + 1; });

        var batch = {
            id: _uid('am'),
            sentAt: Date.now(),
            status: 'sent',
            viewed: false, // 梦角刚提问，角标先显示"new"，用户点开详情页之后才变"未回答"
            favorited: false,
            answeredAt: null,
            receiveDueAt: null,
            receivedAt: null,
            deletedAt: null,
            answers: null,
            questions: picked.map(function (q) { return { id: q.id, text: q.text }; })
        };
        _data.askMe.push(batch);
        _save();
        return batch;
    }

    function _submitAskMeAnswers(id, answersMap) {
        var b = _data.askMe.find(function (x) { return x.id === id; });
        if (!b) return;
        b.answers = answersMap;
        b.status = 'answered_pending';
        b.answeredAt = Date.now();
        // 模拟梦角要过一会儿才"看到"用户的回答，2-5小时后由 _checkAskMeReceiveDue 自动翻成 received
        b.receiveDueAt = Date.now() + _randHours(2, 5) * 3600000;
        _save();
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('已发送回复', 'success');
    }

    // 到点检查：提交回答后过了2-5小时，"梦角已阅"——跟 _checkDueSurveys 是同一个思路，
    // 挂在同一个60秒定时器里一起跑
    function _checkAskMeReceiveDue() {
        if (!_loaded) return;
        var now = Date.now();
        var changed = false;
        _data.askMe.forEach(function (s) {
            if (s.status === 'answered_pending' && !s.deletedAt && s.receiveDueAt && now >= s.receiveDueAt) {
                s.status = 'received';
                s.receivedAt = now;
                changed = true;
            }
        });
        if (changed) { _save(); _refreshOpenViews(); }
    }

    // ── 问卷题库管理（回复库 → 氛围感 → "问卷题库" tab）──────────
    // 内置(60条)+自定义功能完全一致，都可编辑/删除/隐藏；隐藏的不参与 _createAskMeBatch 抽题

    // 新题该给几档：混进题库里"当前正在抽的那一档"（也就是现有题目里最小的 drawCount），
    // 不再固定给0——固定给0意味着新题会独占一个"最优先"的档位，只要一加新题、
    // 下一批必抽它，太规律、没惊喜感了。对齐到当前最小档，就是让它跟其他还没被这一轮抽到
    // 的老题目混在一起随机排队，会不会被抽到看运气，但也不会被晾在很后面迟迟轮不到
    function _currentBankDrawTier() {
        if (!_data.bank || !_data.bank.length) return 0;
        var min = null;
        _data.bank.forEach(function (q) {
            var c = typeof q.drawCount === 'number' ? q.drawCount : 0;
            if (min === null || c < min) min = c;
        });
        return min === null ? 0 : min;
    }

    function _bankAdd(text) {
        text = (text || '').trim();
        if (!text) return;
        _data.bank.push({ id: _uid('bk'), text: text, builtin: false, hidden: false, drawCount: _currentBankDrawTier(), groupId: null });
        _save();
    }
    function _bankEdit(id, text) {
        var q = _data.bank.find(function (x) { return x.id === id; });
        if (!q) return;
        text = (text || '').trim();
        if (!text) return;
        q.text = text;
        _save();
    }
    function _bankDelete(id) {
        _data.bank = _data.bank.filter(function (x) { return x.id !== id; });
        _save();
    }
    function _bankToggleHide(id) {
        var q = _data.bank.find(function (x) { return x.id === id; });
        if (!q) return;
        q.hidden = !q.hidden;
        _save();
        // 跟主字卡"屏蔽"的交互习惯保持一致：置灰 + toast提示。屏蔽之后这道题真的不会
        // 再被抽到（_createAskMeBatch 本来就过滤掉 hidden 的），这里只是把提示补齐
        if (typeof showNotification === 'function') {
            showNotification(q.hidden ? '已屏蔽，这道题不会再出现' : '已启用', q.hidden ? 'info' : 'success');
        }
    }

    // 新增/编辑用小弹窗输入，不用浏览器原生 prompt()——iOS Safari 下原生对话框这类东西
    // 之前踩过坑（confirm() 在 iOS Safari 不好用），而且原生 prompt 长相跟 app 完全不搭
    function _bankPromptModal(title, initialValue, onConfirm) {
        var existing = document.getElementById('survey-bank-prompt-modal');
        if (existing) existing.remove();
        var modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'survey-bank-prompt-modal';
        modal.innerHTML =
            '<div class="modal-content" style="max-width:320px;">' +
                '<div class="modal-title"><i class="fas fa-clipboard-list"></i><span>' + _esc(title) + '</span></div>' +
                '<textarea class="modal-input" id="survey-bank-prompt-input" rows="2" style="resize:none;width:100%;box-sizing:border-box;"></textarea>' +
                '<div class="modal-buttons">' +
                    '<button class="modal-btn modal-btn-secondary" id="survey-bank-prompt-cancel">取消</button>' +
                    '<button class="modal-btn modal-btn-primary" id="survey-bank-prompt-ok">确定</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);
        var input = modal.querySelector('#survey-bank-prompt-input');
        input.value = initialValue || '';
        if (typeof window.showModal === 'function') window.showModal(modal, input); else modal.style.display = 'flex';
        function close() { modal.remove(); }
        modal.querySelector('#survey-bank-prompt-cancel').onclick = close;
        modal.querySelector('#survey-bank-prompt-ok').onclick = function () {
            var val = input.value;
            close();
            onConfirm(val);
        };
    }

    var _bankSearchQuery = '';
    var _activeBankGroupFilter = null; // null=全部（分组视图）, 'ungrouped'=未分组, 或某个分组的id

    function _renderBankTab(list) {
        list.innerHTML =
            '<div class="survey-bank-toolbar-row">' +
                '<input type="text" class="survey-bank-search" id="survey-bank-search" placeholder="搜索题目…" value="' + _esc(_bankSearchQuery) + '">' +
                '<button type="button" class="survey-bank-icon-btn" id="survey-bank-groups-btn" title="分组管理"><i class="fas fa-folder"></i></button>' +
            '</div>' +
            '<div class="survey-bank-filter-pills" id="survey-bank-filter-pills"></div>' +
            '<div id="survey-bank-rows"></div>' +
            '<button type="button" class="survey-add-option-btn" id="survey-bank-add-btn" style="margin-top:8px;">' +
                '<i class="fas fa-plus"></i> 新增题目' +
            '</button>';

        var searchInput = list.querySelector('#survey-bank-search');
        searchInput.oninput = function () { _bankSearchQuery = searchInput.value; _renderBankRows(); };
        list.querySelector('#survey-bank-groups-btn').onclick = function () { _showBankGroupManager(); };
        list.querySelector('#survey-bank-add-btn').onclick = function () { _showBankBatchAddDialog(); };
        _renderBankRows();
    }

    // 批量添加题目——照抄主字卡"批量添加"那套：每行一条+自动去重+可选分组，
    // 唯一区别是分组只能单选一个（用 groupId 挂在题目自己身上，不是分组记数组），
    // 如果打开的时候题库正筛选在某个具体分组下，就默认把那个分组预选上——
    // 这也是修之前那个bug的地方：原来"新增"完全不认当前筛选是什么，新题永远进"未分组"
    function _showBankBatchAddDialog() {
        var groups = _data.bankGroups || [];
        var overlay = (typeof _makeOverlay === 'function') ? _makeOverlay() : _bankFallbackOverlay();
        var hasGroups = groups.length > 0;
        var groupPillsHTML = hasGroups ? (
            '<button class="ba-grp-pill" data-gidx="-1" style="padding:5px 13px;border-radius:20px;font-size:12px;font-family:inherit;cursor:pointer;border:1.5px solid var(--accent-color);background:var(--accent-color);color:#fff;font-weight:700;flex-shrink:0;">不分组</button>' +
            groups.map(function (g, i) {
                return '<button class="ba-grp-pill" data-gidx="' + i + '" style="padding:5px 13px;border-radius:20px;font-size:12px;font-family:inherit;cursor:pointer;border:1.5px solid ' + g.color + '44;background:' + g.color + '18;color:' + g.color + ';font-weight:600;flex-shrink:0;">' +
                    '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + g.color + ';margin-right:4px;vertical-align:middle;"></span>' + _esc(g.name) +
                '</button>';
            }).join('')
        ) : '';

        var panel = document.createElement('div');
        panel.style.cssText = 'background:var(--secondary-bg);border-radius:22px;padding:24px;width:92%;max-width:420px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.45);animation:survPopIn 0.22s cubic-bezier(.34,1.56,.64,1);';
        panel.innerHTML =
            '<style>@keyframes survPopIn { from{opacity:0;transform:scale(.93)} to{opacity:1;transform:scale(1)} } @keyframes survBaGroupSlide { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }</style>' +
            '<div style="flex-shrink:0;font-size:16px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">批量添加题目</div>' +
            '<div style="flex-shrink:0;font-size:12px;color:var(--text-secondary);margin-bottom:14px;line-height:1.6;">每行一条，自动去重</div>' +
            '<div style="flex:1;overflow-y:auto;overflow-x:hidden;min-height:0;">' +
                '<textarea id="survey-ba-input" rows="10" placeholder="在此粘贴内容，每行一条…" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1.5px solid var(--border-color);border-radius:13px;background:var(--primary-bg);color:var(--text-primary);font-size:13px;font-family:inherit;outline:none;resize:vertical;line-height:1.6;"></textarea>' +
                '<div style="font-size:11px;color:var(--text-secondary);margin-top:6px;margin-bottom:12px;"><span id="survey-ba-count">0 条</span></div>' +
                (hasGroups ? (
                    '<div id="survey-ba-group-section" style="margin-bottom:4px;">' +
                        '<button id="survey-ba-group-toggle" style="display:flex;align-items:center;gap:7px;width:100%;padding:9px 12px;border-radius:11px;cursor:pointer;border:1.5px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:12px;font-family:inherit;font-weight:600;text-align:left;">' +
                            '<i class="fas fa-folder" style="font-size:12px;color:var(--accent-color);"></i>' +
                            '<span id="survey-ba-toggle-label">添加到分组</span>' +
                            '<span id="survey-ba-toggle-arrow" style="margin-left:auto;font-size:10px;transition:transform .2s;">▼</span>' +
                        '</button>' +
                        '<div id="survey-ba-group-drawer" style="display:none;overflow-x:auto;overflow-y:hidden;padding:10px 2px 4px;">' +
                            '<div id="survey-ba-group-list" style="display:flex;gap:7px;width:max-content;">' + groupPillsHTML + '</div>' +
                        '</div>' +
                    '</div>'
                ) : '') +
            '</div>' +
            '<div style="flex-shrink:0;padding-top:14px;display:flex;gap:10px;">' +
                '<button id="survey-ba-cancel" style="flex:1;padding:12px;border:1.5px solid var(--border-color);border-radius:13px;background:none;color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">取消</button>' +
                '<button id="survey-ba-confirm" style="flex:2;padding:12px;border:none;border-radius:13px;background:var(--accent-color);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">添加</button>' +
            '</div>';
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        var ta = panel.querySelector('#survey-ba-input');
        var countEl = panel.querySelector('#survey-ba-count');
        ta.addEventListener('input', function () {
            var lines = ta.value.split('\n').filter(function (l) { return l.trim(); });
            countEl.textContent = lines.length + ' 条';
        });
        ta.addEventListener('focus', function () { ta.style.borderColor = 'var(--accent-color)'; });
        ta.addEventListener('blur', function () { ta.style.borderColor = 'var(--border-color)'; });

        var groupToggle = panel.querySelector('#survey-ba-group-toggle');
        var groupDrawer = panel.querySelector('#survey-ba-group-drawer');
        var toggleArrow = panel.querySelector('#survey-ba-toggle-arrow');
        var toggleLabel = panel.querySelector('#survey-ba-toggle-label');
        var _drawerOpen = false;
        function _setDrawer(open) {
            _drawerOpen = open;
            if (!groupDrawer) return;
            groupDrawer.style.display = open ? 'block' : 'none';
            if (open) groupDrawer.style.animation = 'survBaGroupSlide 0.18s ease forwards';
            if (toggleArrow) toggleArrow.style.transform = open ? 'rotate(180deg)' : '';
            if (groupToggle) {
                groupToggle.style.borderColor = open ? 'var(--accent-color)' : 'var(--border-color)';
                groupToggle.style.color = open ? 'var(--text-primary)' : 'var(--text-secondary)';
            }
        }
        if (groupToggle) groupToggle.onclick = function () { _setDrawer(!_drawerOpen); };

        var _selectedGroupIdx = -1;
        // 如果打开批量添加时题库正筛选在某个具体分组，默认预选那个分组
        if (_activeBankGroupFilter && _activeBankGroupFilter !== 'ungrouped') {
            var preIdx = groups.findIndex(function (g) { return g.id === _activeBankGroupFilter; });
            if (preIdx !== -1) _selectedGroupIdx = preIdx;
        }
        var pillContainer = panel.querySelector('#survey-ba-group-list');
        function _refreshPillVisual() {
            if (!pillContainer) return;
            pillContainer.querySelectorAll('.ba-grp-pill').forEach(function (p) {
                var gidx = parseInt(p.dataset.gidx);
                if (gidx === -1) {
                    var isActive = _selectedGroupIdx === -1;
                    p.style.background = isActive ? 'var(--accent-color)' : 'transparent';
                    p.style.color = isActive ? '#fff' : 'var(--text-secondary)';
                    p.style.borderColor = isActive ? 'var(--accent-color)' : 'var(--border-color)';
                } else {
                    var g = groups[gidx];
                    if (!g) return;
                    var isActive2 = _selectedGroupIdx === gidx;
                    p.style.background = isActive2 ? g.color : g.color + '18';
                    p.style.color = isActive2 ? '#fff' : g.color;
                    p.style.borderColor = isActive2 ? g.color : g.color + '44';
                }
            });
            if (toggleLabel) {
                if (_selectedGroupIdx === -1) toggleLabel.textContent = '添加到分组';
                else { var gg = groups[_selectedGroupIdx]; toggleLabel.textContent = gg ? ('分组：' + gg.name) : '添加到分组'; }
            }
        }
        if (pillContainer) {
            pillContainer.onclick = function (e) {
                var pill = e.target.closest('.ba-grp-pill');
                if (!pill) return;
                _selectedGroupIdx = parseInt(pill.dataset.gidx);
                _refreshPillVisual();
            };
        }
        if (_selectedGroupIdx !== -1) _setDrawer(true); // 有预选分组的话，抽屉默认展开，别藏起来
        _refreshPillVisual();

        panel.querySelector('#survey-ba-cancel').onclick = function () { overlay.remove(); };
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
        panel.querySelector('#survey-ba-confirm').onclick = function () {
            var lines = ta.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
            if (!lines.length) { if (typeof showNotification === 'function') showNotification('请输入内容', 'warning'); return; }
            var seen = {};
            _data.bank.forEach(function (x) { seen[normalizeStringStrict(x.text)] = true; });
            var targetGroupId = (_selectedGroupIdx >= 0 && groups[_selectedGroupIdx]) ? groups[_selectedGroupIdx].id : null;
            var startTier = _currentBankDrawTier(); // 批量加的这一批，统一对齐到同一档，不要越加越靠后
            var added = 0, skipped = 0;
            lines.forEach(function (val) {
                var norm = normalizeStringStrict(val);
                if (!norm || seen[norm]) { skipped++; return; }
                seen[norm] = true;
                _data.bank.push({ id: _uid('bk'), text: val, builtin: false, hidden: false, drawCount: startTier, groupId: targetGroupId });
                added++;
            });
            _save();
            overlay.remove();
            _renderBankRows();
            var groupHint = targetGroupId && groups[_selectedGroupIdx] ? ('，已加入「' + groups[_selectedGroupIdx].name + '」') : '';
            if (typeof showNotification === 'function') {
                showNotification('✓ 添加 ' + added + ' 条' + (skipped ? ('，跳过 ' + skipped + ' 条重复') : '') + groupHint, 'success');
            }
        };
    }

    // 题目行的html——不管是"分组视图"里嵌在某个分组下面，还是"筛选出单个分组/未分组"时的平铺列表，都是这一套
    function _bankRowHTML(item) {
        var g = item.groupId ? (_data.bankGroups || []).find(function (x) { return x.id === item.groupId; }) : null;
        var groupBadge = g ? (
            '<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px 1px 4px;border-radius:10px;font-size:10px;' +
            'background:' + g.color + '18;color:' + g.color + ';border:1px solid ' + g.color + '30;margin-top:5px;">' +
            '<span style="width:5px;height:5px;border-radius:50%;background:' + g.color + ';flex-shrink:0;"></span>' + _esc(g.name) + '</span>'
        ) : '';
        return '<div class="custom-reply-item' + (item.hidden ? ' survey-bank-row-hidden' : '') + '" data-id="' + item.id + '">' +
            '<span class="custom-reply-text" style="display:flex;flex-direction:column;align-items:flex-start;gap:3px;">' +
                '<span>' + _esc(item.text) + '</span>' + groupBadge +
            '</span>' +
            '<div class="custom-reply-actions">' +
                '<button class="reply-action-mini hide-btn" title="' + (item.hidden ? '取消隐藏' : '隐藏') + '"><i class="fas fa-eye' + (item.hidden ? '-slash' : '') + '"></i></button>' +
                '<button class="reply-action-mini tag-btn" title="分组"><i class="fas fa-tag"></i></button>' +
                '<button class="reply-action-mini edit-btn" title="编辑"><i class="fas fa-pen"></i></button>' +
                '<button class="reply-action-mini delete-btn" title="删除"><i class="fas fa-trash"></i></button>' +
            '</div>' +
        '</div>';
    }

    function _bindBankRowEvents(rows) {
        rows.querySelectorAll('.custom-reply-item').forEach(function (row) {
            var id = row.dataset.id;
            row.querySelector('.hide-btn').onclick = function () { _bankToggleHide(id); _renderBankRows(); };
            row.querySelector('.tag-btn').onclick = function () { _showSingleBankItemGroupPicker(id); };
            row.querySelector('.edit-btn').onclick = function () {
                var cur = _data.bank.find(function (x) { return x.id === id; });
                _bankPromptModal('编辑题目', cur ? cur.text : '', function (text) {
                    if (text && text.trim()) { _bankEdit(id, text); _renderBankRows(); }
                });
            };
            row.querySelector('.delete-btn').onclick = function () {
                _bankDelete(id);
                _renderBankRows();
            };
        });
    }

    // 筛选胶囊：全部 / 未分组 / 各个分组（带颜色圆点+数量，屏蔽的分组带一个小眼睛图标）——
    // 跟主字卡回复库那套 .gfp-btn 胶囊是同一份样式（reply-library.js 已经全局注入过了，这里直接借用）
    function _renderBankFilterPills() {
        var wrap = document.getElementById('survey-bank-filter-pills');
        if (!wrap) return;
        var groups = _data.bankGroups || [];
        if (!groups.length) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        var allCount = _data.bank.length;
        var ungroupedCount = _data.bank.filter(function (x) { return !x.groupId || !groups.some(function (g) { return g.id === x.groupId; }); }).length;
        var html = '<button class="gfp-btn' + (_activeBankGroupFilter === null ? ' gfp-active' : '') + '" data-filter="all">全部 <span class="gfp-count">' + allCount + '</span></button>';
        html += '<button class="gfp-btn' + (_activeBankGroupFilter === 'ungrouped' ? ' gfp-active' : '') + '" data-filter="ungrouped">未分组 <span class="gfp-count">' + ungroupedCount + '</span></button>';
        groups.forEach(function (g) {
            var cnt = _data.bank.filter(function (x) { return x.groupId === g.id; }).length;
            var active = _activeBankGroupFilter === g.id;
            html += '<button class="gfp-btn' + (active ? ' gfp-active' : '') + (g.disabled ? ' gfp-disabled' : '') + '" data-filter="' + g.id + '"' +
                (active ? ' style="background:' + g.color + '22;border-color:' + g.color + ';color:' + g.color + ';"' : '') + '>' +
                '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + (g.color || '#aaa') + ';margin-right:4px;flex-shrink:0;vertical-align:middle;"></span>' +
                _esc(g.name) + ' <span class="gfp-count">' + cnt + '</span>' +
                (g.disabled ? ' <span style="font-size:9px;opacity:0.7;margin-left:2px;"><i class="fas fa-eye-slash"></i></span>' : '') +
            '</button>';
        });
        wrap.innerHTML = html;
        wrap.querySelectorAll('.gfp-btn').forEach(function (btn) {
            btn.onclick = function () {
                var f = btn.dataset.filter;
                _activeBankGroupFilter = f === 'all' ? null : (f === 'ungrouped' ? 'ungrouped' : f);
                _renderBankRows();
            };
        });
    }

    function _bankEmptyHTML(q, customText) {
        return '<div style="text-align:center;font-size:12.5px;color:var(--text-secondary);opacity:0.6;padding:20px 0;">' +
            (customText || (q ? ('未找到 "' + _esc(q) + '"') : '还没有题目')) + '</div>';
    }

    function _renderBankRows() {
        _renderBankFilterPills();
        var rows = document.getElementById('survey-bank-rows');
        if (!rows) return;
        var q = _bankSearchQuery.toLowerCase().trim();
        var matches = function (x) { return !q || x.text.toLowerCase().indexOf(q) !== -1; };
        var groups = _data.bankGroups || [];

        if (_activeBankGroupFilter === null) {
            // 默认视图：每个分组一个可折叠的区块（跟主字卡"分组管理"里展开/收起是同一个交互），
            // 未分组的（含分组被删掉、groupId 指向不存在分组的孤儿题目）统一放最后一块
            var pool = _data.bank.filter(matches);
            if (!pool.length) { rows.innerHTML = _bankEmptyHTML(q); return; }
            var html = '';
            var usedIds = {};
            groups.forEach(function (g) {
                var items = pool.filter(function (x) { return x.groupId === g.id; });
                items.forEach(function (x) { usedIds[x.id] = true; });
                html += _bankGroupBlockHTML(g, items, false);
            });
            var restUngrouped = pool.filter(function (x) { return !usedIds[x.id]; });
            if (restUngrouped.length) {
                html += _bankGroupBlockHTML({ id: '__ungrouped', name: '未分组', color: '#868E96', disabled: false }, restUngrouped, true);
            }
            rows.innerHTML = html;
            _bindBankGroupBlockEvents(rows);
        } else if (_activeBankGroupFilter === 'ungrouped') {
            var items2 = _data.bank.filter(matches).filter(function (x) { return !x.groupId || !groups.some(function (g) { return g.id === x.groupId; }); });
            if (!items2.length) { rows.innerHTML = _bankEmptyHTML(q, '所有题目都已分组'); return; }
            rows.innerHTML = items2.map(_bankRowHTML).join('');
            _bindBankRowEvents(rows);
        } else {
            var g2 = groups.find(function (x) { return x.id === _activeBankGroupFilter; });
            if (!g2) { rows.innerHTML = _bankEmptyHTML(q, '分组不存在'); return; }
            var items3 = _data.bank.filter(matches).filter(function (x) { return x.groupId === g2.id; });
            if (!items3.length) { rows.innerHTML = _bankEmptyHTML(q, '此分组暂无题目'); return; }
            rows.innerHTML = items3.map(_bankRowHTML).join('');
            _bindBankRowEvents(rows);
        }
    }

    // 分组区块——复用 reply-library.js 里 .rl-group-block/.rl-group-header/.rl-group-tag/.rl-group-body
    // 这几个类（它在文件加载时就往 <head> 塞了一份共享样式，这里直接借用，长相能跟主字卡分组一模一样）
    function _bankGroupBlockHTML(group, items, isUngrouped) {
        var isCollapsed = group._collapsed || false;
        var isDisabled = group.disabled;
        var colorDot = group.color || '#868E96';
        var body = items.length
            ? items.map(_bankRowHTML).join('')
            : '<div style="padding:14px;text-align:center;font-size:12px;color:var(--text-secondary);opacity:0.6;">此分组暂无题目</div>';
        return '<div class="rl-group-block">' +
            '<div class="rl-group-header' + (isCollapsed ? ' collapsed' : '') + '" data-gid="' + group.id + '" style="' + (isDisabled ? 'opacity:0.5;' : '') + '">' +
                '<div class="rl-group-tag" data-gtag="' + group.id + '" title="' + (isDisabled ? '点击启用此分组' : '点击屏蔽此分组') + '">' +
                    '<span style="width:8px;height:8px;border-radius:50%;background:' + colorDot + ';flex-shrink:0;"></span>' +
                    '<span style="font-size:12px;font-weight:700;color:' + colorDot + ';">' + _esc(group.name) + '</span>' +
                    (isDisabled ? '<span title="已屏蔽" style="color:' + colorDot + ';"><i class="fas fa-eye-slash" style="font-size:10px;"></i></span>' : '') +
                '</div>' +
                '<span style="font-size:11px;color:var(--text-secondary);margin-left:auto;">' + items.length + ' 条</span>' +
                (!isUngrouped ? '<button class="survey-bank-group-edit-btn" data-gid="' + group.id + '" title="编辑分组"><i class="fas fa-pen"></i></button>' : '') +
                '<div class="survey-bank-group-chevron" style="transform:' + (isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)') + ';"><i class="fas fa-chevron-down"></i></div>' +
            '</div>' +
            '<div class="rl-group-body" data-gbody="' + group.id + '" style="display:' + (isCollapsed ? 'none' : 'block') + ';">' + body + '</div>' +
        '</div>';
    }

    function _bindBankGroupBlockEvents(rows) {
        rows.querySelectorAll('.rl-group-header').forEach(function (hdr) {
            hdr.onclick = function (e) {
                if (e.target.closest('.survey-bank-group-edit-btn') || e.target.closest('.rl-group-tag')) return;
                var gid = hdr.dataset.gid;
                var body = rows.querySelector('.rl-group-body[data-gbody="' + gid + '"]');
                // 当前是展开的（display 不是 none）→ 点了之后应该变成收起；反过来同理
                var nowCollapsed = !!(body && body.style.display !== 'none');
                if (body) body.style.display = nowCollapsed ? 'none' : 'block';
                hdr.classList.toggle('collapsed', nowCollapsed);
                var chev = hdr.querySelector('.survey-bank-group-chevron');
                if (chev) chev.style.transform = nowCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
                var g = (_data.bankGroups || []).find(function (x) { return x.id === gid; });
                if (g) { g._collapsed = nowCollapsed; _save(); } // "未分组"那个虚拟分组不持久化折叠状态，只在本次渲染内记得住
            };
        });
        rows.querySelectorAll('.rl-group-tag').forEach(function (tag) {
            tag.onclick = function (e) {
                e.stopPropagation();
                var gid = tag.dataset.gtag;
                var g = (_data.bankGroups || []).find(function (x) { return x.id === gid; });
                if (!g) return; // "未分组"没有真实分组对象，点了没反应
                g.disabled = !g.disabled;
                _save();
                _renderBankRows();
                if (typeof showNotification === 'function') showNotification(g.disabled ? '已屏蔽「' + g.name + '」，组内题目不会再被抽到' : '已启用「' + g.name + '」', 'success');
            };
        });
        rows.querySelectorAll('.survey-bank-group-edit-btn').forEach(function (btn) {
            btn.onclick = function (e) {
                e.stopPropagation();
                var gid = btn.dataset.gid;
                var g = (_data.bankGroups || []).find(function (x) { return x.id === gid; });
                if (g) _showBankGroupEditor(g);
            };
        });
        _bindBankRowEvents(rows);
    }

    // ── 分组管理弹窗：新建/编辑/删除分组——跟主字卡回复库的"分组管理"是同一套交互，
    //    直接借用它已经加载好的 _makeOverlay() 和 GROUP_COLORS 调色板，长相保持一致 ──
    function _showBankGroupManager() {
        if (!_data.bankGroups) _data.bankGroups = [];
        var groups = _data.bankGroups;
        var overlay = (typeof _makeOverlay === 'function') ? _makeOverlay() : _bankFallbackOverlay();

        var panel = document.createElement('div');
        panel.style.cssText = 'background:var(--secondary-bg);border-radius:22px;padding:24px;width:92%;max-width:400px;max-height:85vh;display:flex;flex-direction:column;gap:14px;box-shadow:0 24px 80px rgba(0,0,0,.45);animation:survPopIn 0.22s cubic-bezier(.34,1.56,.64,1);';
        panel.innerHTML =
            '<style>@keyframes survPopIn { from{opacity:0;transform:scale(.93)} to{opacity:1;transform:scale(1)} }</style>' +
            '<div style="display:flex;align-items:center;justify-content:space-between;">' +
                '<div style="font-size:16px;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:8px;"><i class="fas fa-folder"></i> 题库分组管理</div>' +
                '<button id="sbgm-close" style="width:30px;height:30px;border-radius:50%;border:none;background:var(--primary-bg);color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;"><i class="fas fa-times"></i></button>' +
            '</div>' +
            '<div id="sbgm-list" style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:55vh;"></div>' +
            '<button id="sbgm-add" style="width:100%;padding:12px;border:1.5px dashed var(--accent-color);border-radius:13px;background:transparent;color:var(--accent-color);font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:7px;">' +
                '<i class="fas fa-plus"></i> 新建分组' +
            '</button>';
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        function render() {
            var listEl = panel.querySelector('#sbgm-list');
            if (!groups.length) {
                listEl.innerHTML = '<div style="text-align:center;padding:32px 0;color:var(--text-secondary);font-size:13px;opacity:0.7;">还没有分组<br><span style="font-size:11px;">点击下方按钮创建第一个分组</span></div>';
            } else {
                listEl.innerHTML = groups.map(function (g, i) {
                    var cnt = _data.bank.filter(function (x) { return x.groupId === g.id; }).length;
                    return '<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:13px;border:1.5px solid var(--border-color);background:var(--primary-bg);' + (g.disabled ? 'opacity:0.55;' : '') + '">' +
                        '<span style="width:12px;height:12px;border-radius:50%;background:' + (g.color || '#868E96') + ';flex-shrink:0;box-shadow:0 0 0 2px ' + (g.color || '#868E96') + '30;"></span>' +
                        '<span style="flex:1;font-size:13px;color:var(--text-primary);font-weight:600;">' + _esc(g.name) + '</span>' +
                        '<span style="font-size:11px;color:var(--text-secondary);">' + cnt + ' 条</span>' +
                        '<button data-action="toggle" data-i="' + i + '" style="width:28px;height:28px;border-radius:8px;border:1px solid var(--border-color);background:' + (g.disabled ? 'var(--accent-color)' : 'transparent') + ';color:' + (g.disabled ? '#fff' : 'var(--text-secondary)') + ';cursor:pointer;display:flex;align-items:center;justify-content:center;" title="' + (g.disabled ? '启用' : '屏蔽') + '"><i class="fas fa-eye' + (g.disabled ? '' : '-slash') + '"></i></button>' +
                        '<button data-action="edit" data-i="' + i + '" style="width:28px;height:28px;border-radius:8px;border:1px solid var(--border-color);background:transparent;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;" title="编辑"><i class="fas fa-pen"></i></button>' +
                        '<button data-action="del" data-i="' + i + '" style="width:28px;height:28px;border-radius:8px;border:1px solid rgba(224,96,90,.3);background:transparent;color:#e0605a;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="删除"><i class="fas fa-trash"></i></button>' +
                    '</div>';
                }).join('');
            }
            listEl.querySelectorAll('[data-action]').forEach(function (btn) {
                btn.onclick = function () {
                    var i = parseInt(btn.dataset.i);
                    var action = btn.dataset.action;
                    if (action === 'toggle') {
                        groups[i].disabled = !groups[i].disabled;
                        _save(); render(); _renderBankRows();
                    } else if (action === 'edit') {
                        overlay.remove();
                        _showBankGroupEditor(groups[i]);
                    } else if (action === 'del') {
                        if (confirm('删除分组「' + groups[i].name + '」？（题目不会被删除，会变成未分组）')) {
                            var gid = groups[i].id;
                            _data.bank.forEach(function (x) { if (x.groupId === gid) x.groupId = null; });
                            groups.splice(i, 1);
                            _save(); render(); _renderBankRows();
                        }
                    }
                };
            });
        }
        render();

        panel.querySelector('#sbgm-close').onclick = function () { overlay.remove(); };
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
        panel.querySelector('#sbgm-add').onclick = function () { overlay.remove(); _showBankGroupEditor(null); };
    }

    // 新建/编辑分组——名称+颜色，颜色板直接借用主字卡那份 GROUP_COLORS
    function _showBankGroupEditor(group) {
        if (!_data.bankGroups) _data.bankGroups = [];
        var groups = _data.bankGroups;
        var isNew = !group;
        var overlay = (typeof _makeOverlay === 'function') ? _makeOverlay() : _bankFallbackOverlay();
        var palette = (typeof GROUP_COLORS !== 'undefined' && GROUP_COLORS.length) ? GROUP_COLORS :
            ['#FF6B6B', '#FF8E53', '#FFC542', '#51CF66', '#20C997', '#4DABF7', '#748FFC', '#DA77F2', '#F783AC', '#FF922B'];
        var selectedColor = (group && group.color) || palette[Math.floor(Math.random() * palette.length)];

        var panel = document.createElement('div');
        panel.style.cssText = 'background:var(--secondary-bg);border-radius:22px;padding:24px;width:92%;max-width:380px;box-shadow:0 24px 80px rgba(0,0,0,.45);animation:survPopIn 0.22s cubic-bezier(.34,1.56,.64,1);';
        panel.innerHTML =
            '<style>@keyframes survPopIn { from{opacity:0;transform:scale(.93)} to{opacity:1;transform:scale(1)} }</style>' +
            '<div style="font-size:16px;font-weight:700;color:var(--text-primary);margin-bottom:18px;">' + (isNew ? '新建分组' : '编辑分组') + '</div>' +
            '<div style="margin-bottom:16px;">' +
                '<label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:7px;letter-spacing:.5px;">分组名称</label>' +
                '<input id="sbge-name" value="' + _esc(group ? group.name : '') + '" placeholder="分组名称…" style="width:100%;box-sizing:border-box;padding:11px 14px;border:1.5px solid var(--border-color);border-radius:12px;background:var(--primary-bg);color:var(--text-primary);font-size:14px;font-family:inherit;outline:none;">' +
            '</div>' +
            '<div style="margin-bottom:20px;">' +
                '<label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:8px;letter-spacing:.5px;">颜色</label>' +
                '<div id="sbge-presets" style="display:flex;gap:7px;flex-wrap:wrap;">' +
                    palette.map(function (c) {
                        return '<div data-preset="' + c + '" style="width:26px;height:26px;border-radius:50%;background:' + c + ';cursor:pointer;border:2.5px solid ' + (c === selectedColor ? '#fff' : 'transparent') + ';box-shadow:' + (c === selectedColor ? ('0 0 0 2.5px ' + c) : 'none') + ';flex-shrink:0;"></div>';
                    }).join('') +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:10px;">' +
                '<button id="sbge-cancel" style="flex:1;padding:12px;border:1.5px solid var(--border-color);border-radius:13px;background:none;color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">取消</button>' +
                '<button id="sbge-save" style="flex:2;padding:12px;border:none;border-radius:13px;background:var(--accent-color);color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">保存</button>' +
            '</div>';
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        panel.querySelectorAll('[data-preset]').forEach(function (dot) {
            dot.onclick = function () {
                selectedColor = dot.dataset.preset;
                panel.querySelectorAll('[data-preset]').forEach(function (d) {
                    var isSel = d.dataset.preset === selectedColor;
                    d.style.border = '2.5px solid ' + (isSel ? '#fff' : 'transparent');
                    d.style.boxShadow = isSel ? ('0 0 0 2.5px ' + d.dataset.preset) : 'none';
                });
            };
        });

        panel.querySelector('#sbge-cancel').onclick = function () { overlay.remove(); };
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
        panel.querySelector('#sbge-save').onclick = function () {
            var name = panel.querySelector('#sbge-name').value.trim();
            if (!name) { if (typeof showNotification === 'function') showNotification('请输入分组名称', 'warning'); return; }
            if (isNew) {
                groups.push({ id: _uid('bg'), name: name, color: selectedColor, disabled: false });
            } else {
                group.name = name;
                group.color = selectedColor;
            }
            _save();
            overlay.remove();
            _renderBankRows();
            if (typeof showNotification === 'function') showNotification(isNew ? '✓ 分组已创建' : '✓ 分组已更新', 'success');
        };
    }

    // 单条题目的分组选择——点题目行的"分组"图标弹出来
    function _showSingleBankItemGroupPicker(itemId) {
        var groups = _data.bankGroups || [];
        if (!groups.length) {
            if (confirm('还没有分组，是否立即创建？')) _showBankGroupEditor(null);
            return;
        }
        var item = _data.bank.find(function (x) { return x.id === itemId; });
        if (!item) return;
        var overlay = (typeof _makeOverlay === 'function') ? _makeOverlay() : _bankFallbackOverlay();
        var currentGroupId = item.groupId;

        var panel = document.createElement('div');
        panel.style.cssText = 'background:var(--secondary-bg);border-radius:22px;padding:22px;width:92%;max-width:340px;box-shadow:0 24px 80px rgba(0,0,0,.45);animation:survPopIn 0.22s cubic-bezier(.34,1.56,.64,1);';
        panel.innerHTML =
            '<style>@keyframes survPopIn { from{opacity:0;transform:scale(.93)} to{opacity:1;transform:scale(1)} }</style>' +
            '<div style="font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:14px;">选择分组</div>' +
            '<div style="display:flex;flex-direction:column;gap:7px;max-height:55vh;overflow-y:auto;margin-bottom:14px;">' +
                '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;border-radius:11px;border:1.5px solid ' + (!currentGroupId ? 'var(--accent-color)' : 'var(--border-color)') + ';background:' + (!currentGroupId ? 'rgba(var(--accent-color-rgb),0.06)' : 'var(--primary-bg)') + ';">' +
                    '<input type="radio" name="sbgp" value="" ' + (!currentGroupId ? 'checked' : '') + '>' +
                    '<span style="font-size:13px;color:var(--text-secondary);">不分组</span>' +
                '</label>' +
                groups.map(function (g) {
                    var checked = currentGroupId === g.id;
                    var cnt = _data.bank.filter(function (x) { return x.groupId === g.id; }).length;
                    return '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px 12px;border-radius:11px;border:1.5px solid ' + (checked ? g.color : 'var(--border-color)') + ';background:' + (checked ? (g.color + '10') : 'var(--primary-bg)') + ';">' +
                        '<input type="radio" name="sbgp" value="' + g.id + '" ' + (checked ? 'checked' : '') + '>' +
                        '<span style="width:9px;height:9px;border-radius:50%;background:' + (g.color || '#aaa') + ';flex-shrink:0;"></span>' +
                        '<span style="flex:1;font-size:13px;color:var(--text-primary);font-weight:600;">' + _esc(g.name) + '</span>' +
                        '<span style="font-size:11px;color:var(--text-secondary);">' + cnt + ' 条</span>' +
                    '</label>';
                }).join('') +
            '</div>' +
            '<div style="display:flex;gap:10px;">' +
                '<button id="sbgp-cancel" style="flex:1;padding:11px;border:1.5px solid var(--border-color);border-radius:12px;background:none;color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">取消</button>' +
                '<button id="sbgp-save" style="flex:2;padding:11px;border:none;border-radius:12px;background:var(--accent-color);color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">确认</button>' +
            '</div>';
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        panel.querySelector('#sbgp-cancel').onclick = function () { overlay.remove(); };
        overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
        panel.querySelector('#sbgp-save').onclick = function () {
            var checked = panel.querySelector('input[name="sbgp"]:checked');
            if (!checked) return;
            item.groupId = checked.value || null;
            _save();
            overlay.remove();
            _renderBankRows();
            if (typeof showNotification === 'function') showNotification('✓ 分组已更新', 'success');
        };
    }

    // 万一 reply-library.js 因为什么原因没加载到（理论上不会，它排在 survey.js 前面），
    // 兜底一个一模一样效果的浮层，不至于直接报错
    function _bankFallbackOverlay() {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.55);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;';
        return overlay;
    }

    window._surveyRenderBankTab = _renderBankTab;
    // 氛围感那个共享的"新增"按钮（回复库/氛围感/公告切来切去都是同一个按钮，不管哪个子tab都显示）
    // 本来完全不认识"问卷题库"这个子tab，点了会掉进它自己的通用兜底逻辑，弹出原生prompt()。
    // 暴露这个出去，让 reply-library.js 那边能在按钮点击时认出"现在是问卷题库"，转发到这边来
    window._surveyShowBankBatchAddDialog = _showBankBatchAddDialog;
    // 给云端迁移脚本（cloud-media-migration.js）用的重新加载钩子——迁移是直接写 localforage，
    // 不走这边的 _save()，如果不重新读一遍，survey.js 内存里还留着老的 base64，
    // 之后随便一个操作触发 _save() 就会把迁移好的云端地址覆盖回去，等于白迁移
    window._surveyReloadFromStorage = function () {
        return _load().then(function () { _refreshOpenViews(); });
    };

    // ── 提醒合并：不管什么来源（问卷回复、以后 Step 3 的反向问卷新提问……），
    //    只要短时间内一起发生，就合并成一条弹窗，不用逐条打扰 ──
    var _notifyQueue = [];
    var _notifyFlushTimer = null;
    function _queueNotify(item) {
        _notifyQueue.push(item);
        clearTimeout(_notifyFlushTimer);
        _notifyFlushTimer = setTimeout(_flushNotify, 1500);
    }
    function _flushNotify() {
        var items = _notifyQueue.slice();
        _notifyQueue = [];
        if (!items.length) return;
        _showMergedReminder(items);
    }

    function _partnerName() {
        return (typeof settings !== 'undefined' && settings.partnerName) || '对方';
    }
    function _myName() {
        return (typeof settings !== 'undefined' && settings.myName) || '我';
    }
    function _randHours(a, b) { return a + Math.random() * (b - a); }

    // 提醒弹窗样式照抄经期记录那套（js/features/period.js 的 _showPdNotif）——
    // 头像+一句话+"稍后/立即查看"两个按钮，8秒自动消失。
    // 是否受陪伴模式/电影院抑制：现有的信件/月经留言/动态互动提醒都没做这个抑制判断
    // （翻了代码确认过，不是漏看），这里跟它们保持一致，不额外加抑制逻辑。
    function _showMergedReminder(items) {
        var existing = document.getElementById('survey-notif-popup');
        if (existing) existing.remove();

        var answeredCount = items.filter(function (it) { return it.type === 'answered'; }).length;
        var newAskMeCount = items.filter(function (it) { return it.type === 'askme_new'; }).length;

        var parts = [];
        if (answeredCount) parts.push(answeredCount + ' 个问卷回复');
        if (newAskMeCount) parts.push(newAskMeCount + ' 个新提问');
        var bodyText = parts.length ? ('你有 ' + parts.join(' + ')) : '有新的问卷动态';

        var pname = _partnerName();
        var realImg = document.querySelector('#partner-avatar img');
        var avatarHtml = (realImg && realImg.src)
            ? '<img src="' + realImg.src + '" style="width:100%;height:100%;object-fit:cover;">'
            : '<i class="fas fa-user" style="font-size:18px;color:var(--text-secondary);"></i>';

        var popup = document.createElement('div');
        popup.id = 'survey-notif-popup';
        popup.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
            'background:var(--secondary-bg);border:1px solid var(--border-color);' +
            'border-radius:20px;padding:18px 20px;z-index:9000;max-width:320px;width:88%;' +
            'box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:12px;' +
            'animation:_mSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);';
        popup.innerHTML =
            '<style>@keyframes _mSlideUp{from{opacity:0;transform:translateX(-50%) translateY(24px) scale(0.9)}60%{transform:translateX(-50%) translateY(-4px) scale(1.02)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}</style>' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
                '<div style="width:36px;height:36px;border-radius:50%;background:rgba(var(--accent-color-rgb),0.12);' +
                    'display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">' + avatarHtml + '</div>' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:700;color:var(--text-primary);">' + pname + ' · 问卷动态</div>' +
                    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">' + bodyText + '</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
                '<button id="survey-notif-later" style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">稍后</button>' +
                '<button id="survey-notif-view" style="flex:2;padding:8px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">立即查看 ✦</button>' +
            '</div>';
        document.body.appendChild(popup);
        popup.querySelector('#survey-notif-later').onclick = function () { popup.remove(); };
        popup.querySelector('#survey-notif-view').onclick = function () {
            popup.remove();
            // 只有一条动态时直接进详情/回答页；混了好几条（不管什么类型）就进列表页让用户自己挑
            if (items.length === 1) {
                _openListModal();
                var only = items[0];
                var src = only.type === 'answered' ? 'partner' : 'me';
                setTimeout(function () { _openDetailModal(only.survey.id, src); }, 320);
            } else {
                _openListModal();
            }
        };
        setTimeout(function () { if (popup.parentNode) popup.remove(); }, 8000);
    }

    // ── 历史列表页 ──────────────────────────────────────────────
    function _fmtTime(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var p2 = function (n) { return String(n).padStart(2, '0'); };
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }

    // 角标状态：src==='partner' 对应"我问梦角"这条线（_data.askPartner），
    // src==='me' 对应"梦角问我"这条线（_data.askMe）——这两个命名是历史遗留，
    // 跟"谁提的问"没关系，别被字面误导
    function _statusBadge(s, src) {
        if (src === 'partner') {
            if (s.status === 'pending') return { text: '等待' + _partnerName() + '回复中', cls: 'pending' };
            if (s.status === 'withdrawn') return { text: '已撤回', cls: 'withdrawn' };
            // status === 'answered'
            return s.viewed ? { text: '已回复', cls: 'answered' } : { text: 'new', cls: 'new' };
        } else {
            if (s.status === 'sent') return s.viewed ? { text: '未回答', cls: 'unanswered' } : { text: 'new', cls: 'new' };
            if (s.status === 'answered_pending') return { text: '已发送回复', cls: 'awaiting-receipt' };
            // status === 'received'
            return { text: '已收到回复', cls: 'received' };
        }
    }

    function _surveyTitle(s) {
        var t = s.questions[0] && s.questions[0].text;
        return (t && t.trim()) ? t.trim() : '（无标题问题）';
    }

    // 能不能收藏：只有"已经有结果/有回答"的才能收藏——等待中/已撤回/梦角问题还没答
    // 这几种半成品状态不给收藏，避免收藏了一份内容还会变的东西
    function _canFavorite(s, src) {
        if (src === 'partner') return s.status === 'answered';
        return s.status === 'answered_pending' || s.status === 'received';
    }

    function _toggleFavorite(id, src) {
        var arr = src === 'me' ? _data.askMe : _data.askPartner;
        var rec = arr.find(function (x) { return x.id === id; });
        if (!rec || !_canFavorite(rec, src)) return;
        rec.favorited = !rec.favorited;
        _save();
        _renderListBody();
        if (typeof showNotification === 'function') showNotification(rec.favorited ? '已收藏' : '已取消收藏', 'success');
    }

    var _activeSurveyFilter = 'all'; // 'all' | 'askme'（梦角发的） | 'askpartner'（用户发的） | 'fav'（收藏）

    // 单个下拉筛选chip——照抄陪伴日记"种类"筛选那一套（.cd-chip / .cd-dropdown / .cd-dropdown-item
    // 这几个类已经在 styles.css 里全局定义好了，直接借用，长相和交互跟陪伴日记一模一样）
    function _renderSurveyFilterBar(allItems) {
        var bar = document.getElementById('survey-fav-filter-bar');
        if (!bar) return;
        var askMeCount = allItems.filter(function (it) { return it.src === 'me'; }).length;
        var askPartnerCount = allItems.filter(function (it) { return it.src === 'partner'; }).length;
        var favCount = allItems.filter(function (it) { return it.ref.favorited; }).length;
        var tabs = [
            { key: 'all', label: '全部', count: allItems.length },
            { key: 'askme', label: _partnerName() + '发的', count: askMeCount },
            { key: 'askpartner', label: _myName() + '发的', count: askPartnerCount },
            { key: 'fav', label: '<i class="fas fa-star" style="font-size:9px;margin-right:4px;"></i>收藏', count: favCount }
        ];
        var current = tabs.filter(function (t) { return t.key === _activeSurveyFilter; })[0] || tabs[0];
        // chip上显示的文字：选中"全部"时不带数字（跟陪伴日记一致，"全部"就是纯文字不强调数量），
        // 选中别的筛选项时，chip变成高亮态并显示当前选的是哪个
        var chipLabel = _activeSurveyFilter === 'all' ? '筛选' : current.label.replace(/<[^>]+>/g, '');

        bar.innerHTML =
            '<div class="cd-chip' + (_activeSurveyFilter !== 'all' ? ' active' : '') + '" id="survey-filter-chip">' +
                '<span id="survey-filter-chip-label">' + chipLabel + '</span>' +
                '<i class="fas fa-chevron-down"></i>' +
                '<div class="cd-dropdown" id="survey-filter-dropdown">' +
                    tabs.map(function (t) {
                        return '<div class="cd-dropdown-item' + (_activeSurveyFilter === t.key ? ' active' : '') + '" data-filter="' + t.key + '">' +
                            t.label + '（' + t.count + '）' +
                        '</div>';
                    }).join('') +
                '</div>' +
            '</div>';

        var chip = bar.querySelector('#survey-filter-chip');
        var dropdown = bar.querySelector('#survey-filter-dropdown');
        if (chip && dropdown) {
            chip.onclick = function (e) {
                e.stopPropagation();
                document.querySelectorAll('.cd-dropdown.open').forEach(function (d) {
                    if (d !== dropdown) d.classList.remove('open');
                });
                dropdown.classList.toggle('open');
            };
            dropdown.querySelectorAll('.cd-dropdown-item').forEach(function (item) {
                item.onclick = function (e) {
                    e.stopPropagation();
                    _activeSurveyFilter = item.dataset.filter;
                    dropdown.classList.remove('open');
                    _renderListBody();
                };
            });
        }
        // 点击空白处收起下拉——只绑一次，不然每次刷新列表都会叠加一个新的监听器
        if (!_surveyFilterOutsideClickBound) {
            _surveyFilterOutsideClickBound = true;
            document.addEventListener('click', function (e) {
                document.querySelectorAll('#survey-filter-dropdown.open').forEach(function (d) {
                    var c = document.getElementById('survey-filter-chip');
                    if (c && !c.contains(e.target)) d.classList.remove('open');
                });
            });
        }
    }
    var _surveyFilterOutsideClickBound = false;

    function _openListModal() {
        _renderListBody();
        if (typeof window.showModal === 'function') window.showModal(document.getElementById('survey-modal'));
        else document.getElementById('survey-modal').style.display = 'flex';
    }
    function _closeListModal() {
        if (typeof window.hideModal === 'function') window.hideModal(document.getElementById('survey-modal'));
        else document.getElementById('survey-modal').style.display = 'none';
    }

    function _renderListBody() {
        var body = document.getElementById('survey-list-body');
        if (!body) return;
        var partnerItems = _data.askPartner.filter(function (s) { return !s.deletedAt; }).map(function (s) { return { ref: s, src: 'partner' }; });
        var meItems = _data.askMe.filter(function (s) { return !s.deletedAt; }).map(function (s) { return { ref: s, src: 'me' }; });
        var all = partnerItems.concat(meItems);

        _renderSurveyFilterBar(all);
        var list = all;
        if (_activeSurveyFilter === 'askme') list = all.filter(function (it) { return it.src === 'me'; });
        else if (_activeSurveyFilter === 'askpartner') list = all.filter(function (it) { return it.src === 'partner'; });
        else if (_activeSurveyFilter === 'fav') list = all.filter(function (it) { return it.ref.favorited; });

        if (!list.length) {
            var emptyTextMap = {
                all: '还没有问卷，问点什么给梦角吧',
                askme: '梦角还没主动问过你问题',
                askpartner: '还没问过梦角问题',
                fav: '还没有收藏的问卷'
            };
            var emptyText = emptyTextMap[_activeSurveyFilter];
            var showCreateBtn = _activeSurveyFilter === 'all' || _activeSurveyFilter === 'askpartner';
            body.innerHTML =
                '<div class="survey-list-empty">' +
                    '<i class="fas fa-clipboard-list"></i>' +
                    '<p>' + emptyText + '</p>' +
                    (showCreateBtn ? '<button type="button" class="survey-empty-create-btn" id="survey-empty-create-btn"><i class="fas fa-plus"></i> 创建问卷</button>' : '') +
                '</div>';
            if (showCreateBtn) {
                var emptyBtn = document.getElementById('survey-empty-create-btn');
                if (emptyBtn) emptyBtn.onclick = function () { _openCreateModal(); };
            }
            _sizeListBody();
            return;
        }
        // 置顶：还需要用户处理/关注的（等待中、有未读新动态、梦角新提问还没答），
        // 不再单独分"已完成"一块——每条记录的状态全靠角标区分，不用分组标题
        var isPinned = function (it) {
            if (it.src === 'partner') return it.ref.status === 'pending' || (it.ref.status === 'answered' && !it.ref.viewed);
            return it.ref.status === 'sent';
        };
        var pinned = list.filter(isPinned).sort(function (a, b) { return (b.ref.createdAt || b.ref.sentAt) - (a.ref.createdAt || a.ref.sentAt); });
        var rest = list.filter(function (it) { return !isPinned(it); }).sort(function (a, b) { return (b.ref.createdAt || b.ref.sentAt) - (a.ref.createdAt || a.ref.sentAt); });

        var html = '';
        pinned.forEach(function (it) { html += _cardHTML(it.ref, it.src); });
        rest.forEach(function (it) { html += _cardHTML(it.ref, it.src); });
        body.innerHTML = html;

        body.querySelectorAll('.survey-card').forEach(function (el) {
            el.onclick = function () { _openDetailModal(el.dataset.sid, el.dataset.src); };
        });
        body.querySelectorAll('.survey-fav-btn').forEach(function (btn) {
            btn.onclick = function (e) {
                e.stopPropagation();
                _toggleFavorite(btn.dataset.favId, btn.dataset.favSrc);
            };
        });
        _sizeListBody();
    }

    // 弹窗高度固定在"大概4张卡片"这个高度，不管实际有几份问卷都不会跟着变矮/变高——
    // 超过4份就在这块区域内部上下滑动看剩下的。量的是第一张卡片的实际渲染高度（卡片高度
    // 会因为标题是1行还是2行有点误差，但足够接近"4份"这个视觉预期了），量不到（比如空状态）
    // 就用一个兜底估算值，保证弹窗不会因为没数据而缩得比平时小
    function _sizeListBody() {
        var body = document.getElementById('survey-list-body');
        if (!body) return;
        requestAnimationFrame(function () {
            var card = body.querySelector('.survey-card');
            var cardH = card ? card.getBoundingClientRect().height : 100;
            var gap = 10; // 对应 .survey-card 的 margin-bottom
            body.style.height = (cardH * 4 + gap * 3) + 'px';
            body.style.overflowY = 'auto';
        });
    }

    function _cardHTML(s, src) {
        var badge = _statusBadge(s, src);
        var srcTagCls = src === 'partner' ? 'survey-tag-src-me' : 'survey-tag-src-partner';
        var srcTagText = (src === 'partner' ? _myName() : _partnerName()) + '问的';
        var createdAt = s.createdAt || s.sentAt;
        var answeredAt = s.answeredAt || s.receivedAt;
        // 只有"已经有结果/有回答"的才给星星按钮，等待中/已撤回/还没回答的不显示——
        // 点星星要 stopPropagation，不然会一起触发卡片本身的"打开详情"点击
        var favStar = _canFavorite(s, src)
            ? '<button class="survey-fav-btn' + (s.favorited ? ' favorited' : '') + '" data-fav-id="' + s.id + '" data-fav-src="' + src + '" title="' + (s.favorited ? '取消收藏' : '收藏') + '"><i class="' + (s.favorited ? 'fas' : 'far') + ' fa-star"></i></button>'
            : '';
        return '<div class="survey-card" data-sid="' + s.id + '" data-src="' + src + '">' +
            '<div class="survey-card-top">' +
                '<span class="survey-tag ' + srcTagCls + '">' + _esc(srcTagText) + '</span>' +
                '<span class="survey-tag survey-tag-status survey-tag-status-' + badge.cls + '">' + _esc(badge.text) + '</span>' +
            '</div>' +
            '<div class="survey-card-title">' + _esc(_surveyTitle(s)) + '</div>' +
            '<div class="survey-card-meta">' + _fmtTime(createdAt) +
                (answeredAt ? (' · 回复于 ' + _fmtTime(answeredAt)) : '') +
                ' · ' + s.questions.length + ' 题</div>' +
            favStar +
        '</div>';
    }

    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ── 详情页 ──────────────────────────────────────────────────
    var _detailCurrentId = null;
    var _detailCurrentSrc = 'partner';

    function _openDetailModal(id, src) {
        _detailCurrentId = id;
        _detailCurrentSrc = src || 'partner';
        // 点开详情页那一刻标记"已读"——"new"角标只在用户还没点开过的时候显示
        var arr = _detailCurrentSrc === 'me' ? _data.askMe : _data.askPartner;
        var rec = arr.find(function (x) { return x.id === id; });
        if (rec && rec.viewed === false) {
            rec.viewed = true;
            _save();
        }
        _renderDetail();
        if (typeof window.showModal === 'function') window.showModal(document.getElementById('survey-detail-modal'));
        else document.getElementById('survey-detail-modal').style.display = 'flex';
        // 列表页可能就在详情页底下开着，角标要立刻跟着变，不用等关闭详情页再刷新
        var listModal = document.getElementById('survey-modal');
        if (listModal && getComputedStyle(listModal).display !== 'none') _renderListBody();
    }
    function _closeDetailModal() {
        if (typeof window.hideModal === 'function') window.hideModal(document.getElementById('survey-detail-modal'));
        else document.getElementById('survey-detail-modal').style.display = 'none';
    }

    function _renderDetail() {
        if (_detailCurrentSrc === 'me') _renderDetailAskMe();
        else _renderDetailPartner();
    }

    function _renderDetailPartner() {
        var s = _data.askPartner.find(function (x) { return x.id === _detailCurrentId; });
        var body = document.getElementById('survey-detail-body');
        var actions = document.getElementById('survey-detail-actions');
        if (!s || !body || !actions) return;

        var badge = _statusBadge(s, 'partner');
        var metaHtml = '<div class="survey-detail-meta-row">' +
            '<span class="survey-tag survey-tag-status survey-tag-status-' + badge.cls + '">' + badge.text + '</span>' +
            '<span>提问于 ' + _fmtTime(s.createdAt) + '</span>' +
            (s.answeredAt ? ('<span>回复于 ' + _fmtTime(s.answeredAt) + '</span>') : '') +
        '</div>';

        var qHtml = s.questions.map(function (q) {
            var selected = (s.selections && s.selections[q.id]) || [];
            var optsHtml = q.options.map(function (o) {
                var isSel = selected.indexOf(o.id) !== -1;
                // 图片选项这里先不直接写 src——o.value 可能是 oss:// 云端引用，浏览器认不出这个协议，
                // 直接当 src 用会直接裂图。先存进 data-src，等 innerHTML 真正插入 DOM 之后，
                // 再统一过一遍，是 oss:// 的走 CloudMedia 懒加载解析成 blob URL，本地 base64 的直接当 src 用
                var inner = (o.kind === 'image')
                    ? '<img class="survey-detail-opt-img" data-src="' + _esc(o.value) + '">'
                    : '<span>' + _esc(o.value) + '</span>';
                return '<div class="survey-detail-opt' + (isSel ? ' selected' : '') + '">' + inner +
                    (isSel ? '<i class="fas fa-check-circle survey-detail-opt-check"></i>' : '') +
                '</div>';
            }).join('');
            return '<div class="survey-detail-q-block">' +
                '<div class="survey-detail-q-text">' + _esc(q.text) + '</div>' +
                optsHtml +
            '</div>';
        }).join('');

        body.innerHTML = metaHtml + qHtml;
        body.querySelectorAll('.survey-detail-opt-img[data-src]').forEach(function (img) {
            var v = img.getAttribute('data-src');
            if (!v) return;
            if (window.CloudMedia && window.CloudMedia.isCloudRef && window.CloudMedia.isCloudRef(v)) {
                window.CloudMedia.bindLazyImage(img, v);
            } else {
                img.src = v;
            }
        });

        if (s.status === 'pending') {
            actions.className = 'modal-buttons';
            actions.innerHTML =
                '<button class="modal-btn modal-btn-secondary" id="survey-detail-withdraw">撤回</button>' +
                '<button class="modal-btn modal-btn-primary" id="survey-detail-edit">编辑</button>';
            actions.querySelector('#survey-detail-withdraw').onclick = function () { _withdrawSurvey(s.id); };
            actions.querySelector('#survey-detail-edit').onclick = function () {
                _closeDetailModal();
                setTimeout(function () { _openCreateModal(s); }, 200);
            };
        } else if (s.status === 'withdrawn') {
            actions.className = 'modal-buttons';
            actions.innerHTML =
                '<button class="modal-btn modal-btn-secondary" id="survey-detail-delete" style="color:#e0605a;">删除</button>' +
                '<button class="modal-btn modal-btn-primary" id="survey-detail-resend">重新发送</button>';
            actions.querySelector('#survey-detail-delete').onclick = function () { _softDeleteSurvey(s.id); };
            actions.querySelector('#survey-detail-resend').onclick = function () { _resendSurvey(s.id); };
        } else {
            // 已回复：单独一个"删除"按钮，靠右下角（survey-buttons-solo 这个类负责让它靠右，见 survey.css）
            actions.className = 'modal-buttons survey-buttons-solo';
            actions.innerHTML = '<button class="modal-btn modal-btn-secondary" id="survey-detail-delete" style="color:#e0605a;">删除</button>';
            actions.querySelector('#survey-detail-delete').onclick = function () { _softDeleteSurvey(s.id); };
        }
    }

    // 反向问卷（梦角问我）详情页：
    //   已发送 → 逐题一个文字输入框，底部"提交"（全部填完才能点亮）
    //   已收到 → 只读展示题目+已填的回答，底部只有"删除"
    function _renderDetailAskMe() {
        var s = _data.askMe.find(function (x) { return x.id === _detailCurrentId; });
        var body = document.getElementById('survey-detail-body');
        var actions = document.getElementById('survey-detail-actions');
        if (!s || !body || !actions) return;

        var badge = _statusBadge(s, 'me');
        var metaHtml = '<div class="survey-detail-meta-row">' +
            '<span class="survey-tag survey-tag-status survey-tag-status-' + badge.cls + '">' + badge.text + '</span>' +
            '<span>提问于 ' + _fmtTime(s.sentAt) + '</span>' +
            (s.receivedAt ? ('<span>回复于 ' + _fmtTime(s.receivedAt) + '</span>') : '') +
        '</div>';

        if (s.status === 'sent') {
            var qHtml = s.questions.map(function (q, qi) {
                return '<div class="survey-detail-q-block">' +
                    '<div class="survey-detail-q-text">' + _esc(q.text) + '</div>' +
                    '<textarea class="survey-answer-input" data-qidx="' + qi + '" placeholder="写点什么…" rows="2"></textarea>' +
                '</div>';
            }).join('');
            body.innerHTML = metaHtml + qHtml;

            var textareas = body.querySelectorAll('.survey-answer-input');
            var submitBtn;
            function updateSubmitState() {
                var allFilled = Array.prototype.every.call(textareas, function (ta) { return ta.value.trim(); });
                if (submitBtn) submitBtn.disabled = !allFilled;
            }
            textareas.forEach(function (ta) { ta.oninput = updateSubmitState; });

            actions.className = 'modal-buttons survey-buttons-solo';
            actions.innerHTML = '<button class="modal-btn modal-btn-primary" id="survey-detail-submit-answer" disabled>提交</button>';
            submitBtn = actions.querySelector('#survey-detail-submit-answer');
            submitBtn.onclick = function () {
                var answers = {};
                textareas.forEach(function (ta) {
                    var q = s.questions[+ta.dataset.qidx];
                    answers[q.id] = ta.value.trim();
                });
                _submitAskMeAnswers(s.id, answers);
            };
            updateSubmitState();
        } else {
            var qHtml2 = s.questions.map(function (q) {
                var answerText = (s.answers && s.answers[q.id]) || '';
                return '<div class="survey-detail-q-block">' +
                    '<div class="survey-detail-q-text">' + _esc(q.text) + '</div>' +
                    '<div class="survey-detail-opt selected"><span>' + _esc(answerText) + '</span></div>' +
                '</div>';
            }).join('');
            body.innerHTML = metaHtml + qHtml2;

            actions.className = 'modal-buttons survey-buttons-solo';
            actions.innerHTML = '<button class="modal-btn modal-btn-secondary" id="survey-detail-delete" style="color:#e0605a;">删除</button>';
            actions.querySelector('#survey-detail-delete').onclick = function () { _softDeleteSurvey(s.id); };
        }
    }

    // ── 撤回 / 软删除（回收站，30天）/ 恢复 / 彻底删除 ────────────
    var _TRASH_TTL = 30 * 24 * 60 * 60 * 1000;

    // 在两个数组里都找一下，返回 {rec, arr} 或 null——回收站/删除这些操作现在两种来源都要处理
    function _findRecord(id) {
        var r = _data.askPartner.find(function (x) { return x.id === id; });
        if (r) return { rec: r, arr: _data.askPartner };
        r = _data.askMe.find(function (x) { return x.id === id; });
        if (r) return { rec: r, arr: _data.askMe };
        return null;
    }

    function _withdrawSurvey(id) {
        var s = _data.askPartner.find(function (x) { return x.id === id; });
        if (!s || s.status !== 'pending') return;
        s.status = 'withdrawn';
        _save();
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('问卷已撤回', 'info');
    }

    function _softDeleteSurvey(id) {
        var found = _findRecord(id);
        if (!found) return;
        found.rec.deletedAt = Date.now();
        _save();
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('已删除，30天内可在回收站恢复', 'info');
    }

    // 撤回的问卷可以"重新发送"——原样复制一份题目内容，当成一份全新的问卷发出去
    // （新 id、新的创建时间、重新随机一个 dueAt），跟原来那份撤回的问卷互不影响
    function _resendSurvey(id) {
        var s = _data.askPartner.find(function (x) { return x.id === id; });
        if (!s) return;
        var fresh = {
            id: _uid('sv'),
            createdAt: Date.now(),
            dueAt: _randomDueAt(),
            status: 'pending',
            answeredAt: null,
            deletedAt: null,
            viewed: true,
            favorited: false,
            selections: null,
            questions: JSON.parse(JSON.stringify(s.questions))
        };
        // 撤回后重发，原来那份撤回记录就不再占列表位置了——软删除挪进回收站，
        // 30天内还能恢复，跟"彻底消失"和"误删无法找回"都不一样
        s.deletedAt = Date.now();
        _data.askPartner.push(fresh);
        _save();
        _migrateOptionImagesToCloud(fresh); // 万一原问卷的图片选项当时是本地base64、现在配了OSS，顺手迁移一下
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('已作为新问卷重新发出', 'success');
    }

    // 开机自检+每次打开回收站前都清一次——过期的直接从数组里摘掉，不占地方
    function _cleanTrash() {
        var filterFn = function (s) { return !s.deletedAt || (Date.now() - s.deletedAt) < _TRASH_TTL; };
        _data.askPartner = _data.askPartner.filter(filterFn);
        _data.askMe = _data.askMe.filter(filterFn);
    }

    function _openTrashModal() {
        _cleanTrash();
        _save();
        _renderTrashBody();
        if (typeof window.showModal === 'function') window.showModal(document.getElementById('survey-trash-modal'));
        else document.getElementById('survey-trash-modal').style.display = 'flex';
    }
    function _closeTrashModal() {
        if (typeof window.hideModal === 'function') window.hideModal(document.getElementById('survey-trash-modal'));
        else document.getElementById('survey-trash-modal').style.display = 'none';
    }

    function _renderTrashBody() {
        var body = document.getElementById('survey-trash-body');
        if (!body) return;
        var trashedPartner = _data.askPartner.filter(function (s) { return s.deletedAt; }).map(function (s) { return { rec: s, src: 'partner' }; });
        var trashedMe = _data.askMe.filter(function (s) { return s.deletedAt; }).map(function (s) { return { rec: s, src: 'me' }; });
        var trashed = trashedPartner.concat(trashedMe).sort(function (a, b) { return b.rec.deletedAt - a.rec.deletedAt; });
        if (!trashed.length) {
            body.innerHTML = '<div style="text-align:center;font-size:12.5px;color:var(--text-secondary);opacity:0.6;padding:24px 0;">回收站是空的</div>';
            return;
        }
        body.innerHTML = trashed.map(function (it) {
            var s = it.rec;
            var daysLeft = Math.max(0, Math.ceil((_TRASH_TTL - (Date.now() - s.deletedAt)) / 86400000));
            return '<div class="survey-trash-row" data-sid="' + s.id + '">' +
                '<span class="survey-trash-title">' + _esc(_surveyTitle(s)) + '</span>' +
                '<span class="survey-trash-days">还剩' + daysLeft + '天</span>' +
                '<button class="survey-trash-btn-mini" data-act="restore">恢复</button>' +
                '<button class="survey-trash-btn-mini danger" data-act="wipe">彻底删除</button>' +
            '</div>';
        }).join('');
        body.querySelectorAll('.survey-trash-btn-mini').forEach(function (btn) {
            btn.onclick = function () {
                var row = btn.closest('.survey-trash-row');
                var sid = row.dataset.sid;
                if (btn.dataset.act === 'restore') {
                    var found = _findRecord(sid);
                    if (found) { found.rec.deletedAt = null; _save(); }
                } else {
                    _data.askPartner = _data.askPartner.filter(function (x) { return x.id !== sid; });
                    _data.askMe = _data.askMe.filter(function (x) { return x.id !== sid; });
                    _save();
                }
                _renderTrashBody();
                _refreshOpenViews();
            };
        });
    }

    // 有变化时，如果对应页面正开着，就顺手刷新一下，不用用户自己关了再开
    function _refreshOpenViews() {
        var listModal = document.getElementById('survey-modal');
        if (listModal && getComputedStyle(listModal).display !== 'none') _renderListBody();
        var detailModal = document.getElementById('survey-detail-modal');
        if (detailModal && getComputedStyle(detailModal).display !== 'none' && _detailCurrentId) _renderDetail();
    }

    // ── 调试用（console 里跑，不会自动执行）──────────────────────
    window._surveyDebugList = function () { console.log(JSON.parse(JSON.stringify(_data.askPartner))); return _data.askPartner; };
    window._surveyDebugClear = function () { _data.askPartner = []; _save(); console.log('[survey] askPartner 已清空'); };
    // 直接把某一份问卷的 dueAt 改成"刚刚"，方便测试到点计算逻辑，不用真的等几个小时；
    // 传 true 会紧接着立刻跑一次检查（不用等下一次60秒轮询）
    window._surveyDebugForceDue = function (idOrIndex, checkNow) {
        var s = (typeof idOrIndex === 'number') ? _data.askPartner[idOrIndex] : _data.askPartner.find(function (x) { return x.id === idOrIndex; });
        if (!s) { console.warn('[survey] 没找到这份问卷'); return; }
        s.dueAt = Date.now() - 1000;
        _save();
        console.log('[survey] 已把这份问卷的 dueAt 改成刚刚：', s.id);
        if (checkNow) _checkDueSurveys();
    };
    window._surveyOpenCreateModal = function () { _openCreateModal(); };
    window._surveyOpenListModal = _openListModal;
    window._surveyOpenDetailModal = _openDetailModal;
    window._surveyDebugListAskMe = function () { console.log(JSON.parse(JSON.stringify(_data.askMe))); return _data.askMe; };
    // 把某条"已发送回复"记录的 receiveDueAt 改成"刚刚"，方便测试"梦角已阅"这一步不用真等2-5小时
    window._surveyDebugForceReceive = function (idOrIndex, checkNow) {
        var s = (typeof idOrIndex === 'number') ? _data.askMe[idOrIndex] : _data.askMe.find(function (x) { return x.id === idOrIndex; });
        if (!s) { console.warn('[survey] 没找到这条反向问卷'); return; }
        if (s.status !== 'answered_pending') { console.warn('[survey] 这条不是"已发送回复"状态，当前状态：', s.status); return; }
        s.receiveDueAt = Date.now() - 1000;
        _save();
        console.log('[survey] 已把这条的 receiveDueAt 改成刚刚：', s.id);
        if (checkNow) _checkAskMeReceiveDue();
    };
    window._surveyDebugBank = function () { console.log(JSON.parse(JSON.stringify(_data.bank))); return _data.bank; };
    // 直接切换某条记录的收藏状态，不用在列表页里翻找星星按钮点——src 传 'partner'（我问梦角，默认）
    // 或 'me'（梦角问我）；idOrIndex 可以是序号（配合 _surveyDebugList/_surveyDebugListAskMe 看序号）也可以是id。
    // 走的是跟点星星按钮完全一样的 _toggleFavorite，所以还没到"已完成"状态的记录一样收藏不了
    window._surveyDebugFavorite = function (idOrIndex, src) {
        src = src || 'partner';
        var arr = src === 'me' ? _data.askMe : _data.askPartner;
        var rec = (typeof idOrIndex === 'number') ? arr[idOrIndex] : arr.find(function (x) { return x.id === idOrIndex; });
        if (!rec) { console.warn('[survey] 没找到这条记录'); return; }
        if (!_canFavorite(rec, src)) { console.warn('[survey] 这条还不能收藏（不是"已完成"状态），当前状态：', rec.status); return; }
        _toggleFavorite(rec.id, src);
        console.log('[survey] 收藏状态：', rec.favorited);
    };
    // 强制立刻触发一次反向问卷（不用等5-8天），传 true 强制必中（跳过概率判定），方便测试抽题/去重逻辑
    window._surveyDebugForceAskMe = function (forceHit) {
        if (forceHit) {
            var batch = _createAskMeBatch();
            if (batch) { _data.askMeTrigger.missStreak = 0; _save(); console.log('[survey] 已生成一批反向问卷：', batch.id); }
            else console.warn('[survey] 题库里没有可用（未隐藏）的题目');
            return;
        }
        _data.askMeTrigger.nextCheckAt = Date.now() - 1000;
        _save();
        _checkAskMeTrigger();
    };
    // 跟上面那个不一样：这个会连提醒弹窗一起触发，走的是跟真实流程完全一样的路径
    // （生成问卷 → missStreak清零 → 排队提醒 → 刷新已打开的界面），方便测试提醒弹窗长什么样
    window._surveyDebugForceAskMeWithNotify = function () {
        var batch = _createAskMeBatch();
        if (batch) {
            _data.askMeTrigger.missStreak = 0;
            _queueNotify({ type: 'askme_new', survey: batch });
            _refreshOpenViews();
            _save();
            console.log('[survey] 已生成一批反向问卷并触发提醒：', batch.id);
        } else {
            console.warn('[survey] 题库里没有可用（未隐藏）的题目');
        }
    };

    // ── 初始化 ────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        var addQBtn = document.getElementById('survey-add-q-btn');
        if (addQBtn) addQBtn.onclick = function () {
            _draftQuestions.push(_newDraftQuestion());
            _renderDraftQuestions();
        };
        var cancelBtn = document.getElementById('survey-create-cancel');
        if (cancelBtn) cancelBtn.onclick = _closeCreateModal;
        var sendBtn = document.getElementById('survey-create-send');
        if (sendBtn) sendBtn.onclick = _submitCreate;

        var listCloseBtn = document.getElementById('survey-list-close');
        if (listCloseBtn) listCloseBtn.onclick = _closeListModal;
        var addBtn = document.getElementById('survey-add-btn');
        if (addBtn) addBtn.onclick = function () { _openCreateModal(); };
        var trashBtn = document.getElementById('survey-trash-btn');
        if (trashBtn) trashBtn.onclick = _openTrashModal;

        var detailBackBtn = document.getElementById('survey-detail-back');
        if (detailBackBtn) detailBackBtn.onclick = _closeDetailModal;

        var trashCloseBtn = document.getElementById('survey-trash-close');
        if (trashCloseBtn) trashCloseBtn.onclick = _closeTrashModal;

        _bindDelaySliders();
    });

    // 每分钟检查一次到点的问卷（照抄 period.js 的轮询方式）；反向问卷的触发检查间隔是"天"级别的，
    // 不需要这么密，但挂在同一个 60秒 定时器里跑一下也没什么成本，简单点，不用另开一个定时器
    setInterval(function () { _checkDueSurveys(); _checkAskMeTrigger(); _checkAskMeReceiveDue(); }, 60000);

    _load().then(function () {
        _cleanTrash();
        _save();
        setTimeout(function () { _checkDueSurveys(); _checkAskMeTrigger(); _checkAskMeReceiveDue(); }, 4000);
    });
})();
