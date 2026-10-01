/* ============================================================
   更多菜单（输入区 "+" 按钮）框架 v2
   - 微信同款交互：点"+"在输入框下方展开一整块网格面板（不是浮层），
     推开聊天区域，不盖在消息上面
   - 输入框一旦有文字，"+"自动换成"发送"，跟微信一样
   - 已实现的功能项：直接执行 action
   - 未开发的功能项：统一走 showNotification 弹"开发中"提示
   - 后续开发红包/位置共享等功能时，直接调用 window.MoreMenu.registerItem()
     把对应项从"占位"升级成"真实功能"，不需要再碰这个文件的面板/切换逻辑
   ============================================================ */

(function () {
    // 图标里 emoji 优先于 iconClass（emoji 更容易一眼分辨，比如红包用 🧧 而不是信封，
    // 避免跟信箱功能的信封图标混淆）；iconClass 支持传完整的 class 字符串（包括 fab 品牌图标）
    // 顺序：图片/让ta主动/红包/批量发送/位置/快问快答。
    // "视频通话"和"让梦角主动说话"对调了位置：视频通话挪回输入区主行显示，
    // "让梦角主动说话"(原 continue-btn)挪进这个面板，显示名叫"让ta主动"。
    // 原来的"位置/小红书/抖音/快问快答"那一整行先隐藏了，这些功能都还没做，
    // 留着一排点了只会弹"开发中"的占位格子没有意义。做好了哪个再挪回来加进这个数组就行，
    // 不用改这个文件其它任何逻辑——面板本身是按这个数组自动渲染的，加/删条目会自动跟着调整布局。
    const MORE_MENU_ITEMS = [
        {
            id: 'image',
            iconClass: 'fas fa-image',
            label: '图片',
            ready: true,
            action: function () {
                const input = document.getElementById('image-input');
                if (input) input.click();
            }
        },
        {
            id: 'continue',
            // 头像居中 + 右上角带三个点的对话气泡，代表"让ta主动说句话"。
            // 用 svgIcon 而不是 iconClass，因为这是设计好的复合图标，不是字体库里现成的单个符号
            svgIcon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:28px;height:28px;" fill="none">' +
                '<circle cx="12" cy="10" r="4.3" fill="currentColor"/>' +
                '<path d="M5.7 21.5c0-4.7 3-7.4 6.3-7.4s6.3 2.7 6.3 7.4" fill="currentColor"/>' +
                '<rect x="15.8" y="0.8" width="7.1" height="5.3" rx="2.65" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
                '<path d="M17.8 6.0 17.0 7.3 18.7 6.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' +
                '<circle cx="17.9" cy="3.45" r="0.65" fill="currentColor"/>' +
                '<circle cx="19.35" cy="3.45" r="0.65" fill="currentColor"/>' +
                '<circle cx="20.8" cy="3.45" r="0.65" fill="currentColor"/>' +
                '</svg>',
            label: '让ta主动',
            ready: true,
            action: function () {
                if (typeof simulateReply === 'function') simulateReply();
            }
        },
        {
            id: 'redpacket',
            svgIcon: '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" style="width:22px;height:22px;">' +
                '<path d="M925.888 76.8v400.96c-57.088 73.408-134.08 130.56-222.848 163.328C681.536 570.112 615.616 518.4 537.6 518.4c-79.936 0-147.264 54.336-166.912 128.064-95.36-31.616-178.048-91.072-238.4-168.704V76.8c0-42.24 34.56-76.8 76.8-76.8h640c42.24 0 76.8 34.56 76.8 76.8z" fill="currentColor"/>' +
                '<path d="M925.888 554.56V947.2c0 42.24-34.56 76.8-76.8 76.8h-640c-42.24 0-76.8-34.56-76.8-76.8V554.56c59.712 76.8 141.248 135.808 235.328 167.68C382.208 802.88 452.8 864 537.6 864c87.104 0 159.168-64.448 171.072-148.288 86.464-33.024 161.344-89.344 217.216-161.152z" fill="currentColor"/>' +
                '<path d="M659.2 691.2c0 14.976-2.688 29.312-7.68 42.56C634.24 779.904 589.76 812.8 537.6 812.8c-50.496 0-93.824-30.784-112.192-74.688-6.08-14.4-9.408-30.272-9.408-46.912 0-10.752 1.408-21.184 4.032-31.104C433.792 608 481.216 569.6 537.6 569.6c55.04 0 101.504 36.544 116.48 86.72 3.328 11.072 5.12 22.784 5.12 34.88z" fill="currentColor"/>' +
                '</svg>',
            label: '红包', ready: false
        },
        {
            id: 'batch',
            iconClass: 'fas fa-layer-group',
            label: '批量发送',
            ready: true,
            action: function () {
                if (typeof toggleBatchMode === 'function') toggleBatchMode();
            }
        },
        // 占位项，真正的"搞怪"逻辑（右下角道具面板：番茄/鸡蛋/蛋糕/水桶）在
        // js/features/throw-egg.js 里，它加载后会调用 registerItem('throw-egg', ...)
        // 把这项升级成真实功能
        {
            id: 'throw-egg',
            // 单色实心小鬼：圆顶身体 + 波浪底边 + 一大一小的眼睛 + 张开的嘴，颜色跟随主题（currentColor）
            svgIcon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:26px;height:26px;" fill="currentColor">' +
                '<path fill-rule="evenodd" d="M12 2.4C7.9 2.4 4.8 5.6 4.8 9.8V19.8Q6.6 22.6 8.4 19.8T12 19.8T15.6 19.8T19.2 19.8V9.8C19.2 5.6 16.1 2.4 12 2.4ZM9 8.4a1.6 1.6 0 1 0 .01 0ZM15.2 8.9a1.1 1.1 0 1 0 .01 0ZM8.9 13.2Q12 17.6 15.1 13.2Z"/>' +
                '</svg>',
            label: '搞怪',
            ready: false
        },
        // 加回"位置"和"快问快答"这两个（凑够6个，两行各3个/4个，看起来不那么空），
        // 小红书/抖音还是先不加，功能都没做
        { id: 'location', iconClass: 'fas fa-location-dot', label: '位置', ready: false },
        { id: 'qa', iconClass: 'fas fa-comments', label: '快问快答', ready: false }
        // { id: 'xiaohongshu', iconClass: 'fas fa-book', label: '小红书', ready: false },
        // { id: 'douyin', iconClass: 'fab fa-tiktok', label: '抖音', ready: false }
    ];

    function getPanel() { return document.getElementById('more-menu-panel'); }
    function getPlusBtn() { return document.getElementById('more-menu-btn'); }
    function getSendBtn() { return document.getElementById('send-btn'); }
    function getInput() { return document.getElementById('message-input'); }

    // 不要任何展开/收起动效——切换要立刻到位，所以这里不再用 setTimeout 延迟隐藏
    // 等过渡播完（那是配合 CSS max-height transition 写的，现在 CSS 那条 transition 已经删了）
    function closeMoreMenu() {
        const panel = getPanel(), btn = getPlusBtn();
        if (panel) {
            panel.classList.remove('active');
            panel.style.display = 'none';
        }
        if (btn) btn.classList.remove('active');
    }

    function openMoreMenu() {
        const panel = getPanel(), btn = getPlusBtn();
        if (!panel || !btn) return;
        // 跟输入区其它弹层（表情/拍一拍、收纳面板）互斥，避免叠在一起
        try {
            document.getElementById('user-sticker-picker')?.classList.remove('active');
            const extrasPanel = document.getElementById('collapsed-extras-panel');
            if (extrasPanel) extrasPanel.style.display = 'none';
            document.getElementById('collapse-expand-btn')?.classList.remove('open');
        } catch (e) {}
        // 跟微信一样：展开面板前先收起软键盘，把屏幕空间让给图标网格
        const input = getInput();
        if (input) input.blur();
        panel.style.display = 'block';
        panel.classList.add('active');
        btn.classList.add('active');
    }

    function toggleMoreMenu() {
        const panel = getPanel();
        if (panel && panel.classList.contains('active')) closeMoreMenu();
        else openMoreMenu();
    }

    function renderMoreMenu() {
        const panel = getPanel();
        if (!panel) return;
        const gridHTML = MORE_MENU_ITEMS.map(function (item) {
            const iconHTML = item.svgIcon
                ? item.svgIcon
                : (item.emoji
                    ? '<span class="more-menu-emoji">' + item.emoji + '</span>'
                    : '<i class="' + item.iconClass + '"></i>');
            return (
                '<button class="more-menu-item' + (item.ready ? '' : ' disabled') + '" data-id="' + item.id + '" title="' + item.label + '">' +
                '<span class="more-menu-icon">' + iconHTML + '</span>' +
                '<span class="more-menu-label">' + item.label + '</span>' +
                '</button>'
            );
        }).join('');
        panel.innerHTML = '<div class="more-menu-grid">' + gridHTML + '</div>';

        panel.querySelectorAll('.more-menu-item').forEach(function (btnEl) {
            btnEl.addEventListener('click', function () {
                const item = MORE_MENU_ITEMS.find(function (i) { return i.id === btnEl.dataset.id; });
                if (!item) { closeMoreMenu(); return; }
                if (item.ready && typeof item.action === 'function') {
                    // "图片"是特殊情况：面板不能在这里就收起，要等用户真的选完图、
                    // 触发发送之后才收（见下面 DOMContentLoaded 里挂在 #image-input 上的 change 监听）
                    if (item.id !== 'image') closeMoreMenu();
                    item.action();
                } else {
                    closeMoreMenu();
                    if (typeof showNotification === 'function') {
                        showNotification('「' + item.label + '」功能开发中，敬请期待～', 'info', 2200);
                    }
                }
            });
        });
    }

    // 供后续开发（红包等）把占位项升级为真实功能，不用改这个文件的面板/切换逻辑
    function registerItem(id, patch) {
        const item = MORE_MENU_ITEMS.find(function (i) { return i.id === id; });
        if (!item) return;
        Object.assign(item, patch);
        renderMoreMenu();
    }

    // "+" 常驻，不会被输入框里的文字换掉；"发送"按钮完全不要，永远隐藏——
    // 发消息统一走回车/其它已有路径，这个坑位上只留"+"一个按钮。
    // 用 setProperty 加 important 优先级来设置显示状态，不能只是普通的 style.display='xxx'——
    // 因为 styles.css 里有条老规则 #send-btn{display:none!important}（应该是更早某个方案遗留下来的），
    // 普通内联样式斗不过样式表里的!important，只有内联样式自己也标 important 才压得过去。
    // 不去动 styles.css 那条规则（受保护文件），从这边把它压制掉就行
    function syncTrailingButton() {
        const input = getInput(), plusBtn = getPlusBtn(), sendBtn = getSendBtn();
        if (!input || !plusBtn) return;
        plusBtn.style.setProperty('display', 'flex', 'important');
        if (sendBtn) sendBtn.style.setProperty('display', 'none', 'important');
    }

    document.addEventListener('DOMContentLoaded', function () {
        renderMoreMenu();
        syncTrailingButton();

        const plusBtn = getPlusBtn();
        if (plusBtn) {
            plusBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleMoreMenu();
            });
        }

        const input = getInput();
        if (input) {
            input.addEventListener('input', syncTrailingButton);
            // 发消息（回车 或 点发送按钮）都是程序化清空输入框的值，不会触发原生input事件——
            // 之前只监听了input，导致发完消息按钮状态卡在"发送中"那一刻，永远切不回加号。
            // keyup 覆盖回车发送，下面对发送按钮的click监听覆盖点击发送，两条路径发完都强制重新同步一次
            input.addEventListener('keyup', function () { setTimeout(syncTrailingButton, 0); });
            // 聚焦输入框时（唤起软键盘）收起"更多"面板，避免面板和键盘抢屏幕
            input.addEventListener('focus', closeMoreMenu);
        }

        const sendBtnEl = getSendBtn();
        if (sendBtnEl) {
            sendBtnEl.addEventListener('click', function () { setTimeout(syncTrailingButton, 0); });
        }

        // 点击面板/输入区以外的地方自动收起
        document.addEventListener('click', function (e) {
            const panel = getPanel(), btn2 = getPlusBtn();
            if (!panel || !panel.classList.contains('active')) return;
            if (panel.contains(e.target) || (btn2 && btn2.contains(e.target))) return;
            // "图片"项点击后会用 input.click() 模拟点开系统相册，这个模拟点击本身
            // 也会冒泡到 document 被这里的"点外部"逻辑抓到，导致相册还没弹出面板就先收起了——
            // #image-input 不算"外部"，直接放过
            if (e.target.id === 'image-input') return;
            closeMoreMenu();
        });

        // 图片：真正选完图（触发发送）之后再收起面板，不是点"图片"按钮那一下就收
        const imageInput = document.getElementById('image-input');
        if (imageInput) {
            imageInput.addEventListener('change', function () {
                if (imageInput.files && imageInput.files[0]) closeMoreMenu();
            });
        }
    });

    window.MoreMenu = {
        open: openMoreMenu,
        close: closeMoreMenu,
        toggle: toggleMoreMenu,
        registerItem: registerItem,
        syncTrailingButton: syncTrailingButton
    };
})();
