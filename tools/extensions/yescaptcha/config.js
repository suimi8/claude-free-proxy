const config = {
    // ============================================================
    //  基础配置 / Basic Configuration
    // ============================================================
    clientKey: '', // 你购买授权的 clientKey / Your licensed clientKey
    host: 'https://api.yescaptcha.com', // 服务器地址，默认官网服务器 / API server address (default: official server)

    // ============================================================
    //  总开关 / Master Switch
    // ============================================================
    autorun: true, // 自动运行 / Auto run (true | false)

    // ============================================================
    //  已弃用配置（请勿使用）/ Deprecated (do not use)
    // ============================================================
    imageclassification: true, // （已弃用）reCaptcha 谷歌人机自动识别 / (deprecated) reCaptcha auto recognition
    hcaptcha: true, // （已弃用）hCaptcha 人机自动识别 / (deprecated) hCaptcha auto recognition
    imagetotext: true, // （已弃用）Coinlist 英文数字人机自动识别 / (deprecated) Coinlist text recognition
    rainbow: true, // （已弃用）Coinlist 排队时粉色按钮自动点击 / (deprecated) auto-click pink button while queuing
    times: 200, // （已弃用）点击图片的间隔时间，单位毫秒 / (deprecated) image click interval (ms)

    // ============================================================
    //  通用行为配置 / General Behavior
    // ============================================================
    isTextCaptcha: false, // 开启文字验证码识别 / Enable text captcha recognition
    endTimes: '20', // 在几次识别流程后停止识别 / Stop after N recognition flows
    isAutoClickCheckBox: true, // 是否自动点击 checkBox / Auto-click the checkbox
    checkBoxClickDelayTime: '500', // 页面加载之后延迟多久自动点击 checkBox（毫秒）/ Delay before auto-clicking the checkbox after page load (ms)
    isOpenEndTimes: true, // 是否开启「在几次识别流程后停止识别」功能 / Enable the "stop after N flows" feature
    isOpenCloudflare: false, // 是否开启 Cloudflare 验证 / Enable Cloudflare Turnstile
    isOpenCloudflareTurnstileProtocol: false, // 是否开启 Cloudflare Turnstile 协议版 / Enable Cloudflare Turnstile protocol
    isAutoSubmit: true, // 一次九宫格验证中，是否自动点击提交按钮 / Auto-click the submit button in a grid challenge
    autoSubmitDelayTime: 100, // 自动提交之前间隔时间，单位毫秒 / Delay before auto-submit (ms)
    autoSubmitDelayFloatRate: 0.1, // 自动提交之前间隔时间浮动比例，数值 0~1 / Auto-submit delay jitter ratio (0~1)

    // ============================================================
    //  JS 注入与外部控制 / JS Injection & External Control
    // ============================================================
    workStatusFlag: '', // 工作状态标志名 / Work-status flag name
    jsControlObjectName: 'yesCaptcha', // 页面 JS 控制对象名称 / JS control object name exposed to the page
    allowJsInject: false, // 是否允许向页面注入 JS 控制对象 / Allow injecting the JS control object into the page

    // ============================================================
    //  网络设置 / Network Settings
    // ============================================================
    network: {
        hcaptchaVerifyFailDelay: 1000, // hCaptcha 解析请求失败后的重试延迟（毫秒，网络不佳时）/ hCaptcha retry delay after failure (ms)
        hcaptchaVerifyTry: 3, // hCaptcha 单次解析请求的重试次数 / hCaptcha retry attempts
        recaptchaVerifyFailDelay: 1000, // reCaptcha 解析请求失败后的重试延迟（毫秒）/ reCaptcha retry delay after failure (ms)
        recaptchaVerifyTry: 2, // reCaptcha 单次解析请求的重试次数 / reCaptcha retry attempts
        funcaptchaVerifyFailDelay: 1000, // FunCaptcha 解析请求失败后的重试延迟（毫秒）/ FunCaptcha retry delay after failure (ms)
        funcaptchaVerifyTry: 3 // FunCaptcha 单次解析请求的重试次数 / FunCaptcha retry attempts
    },

    // ============================================================
    //  hCaptcha 独立配置 / hCaptcha Specific
    // ============================================================
    hcaptchaConfig: {
        isPassDragChallenge: false, // 是否跳过拖动挑战（已弃用）/ Skip drag challenge (deprecated)
        isAutoRefresh: true, // 是否失败自动刷新 / Auto refresh on failure
        isSwitchToEnglishContent: false, // 是否将验证码切换为英文 / Switch captcha to English
        isPassMoveCanvasChallenge: false, // 是否跳过动图挑战 / Skip animated-canvas challenge
        canvasRecordDuration: 6000, // 动图录制时长（毫秒）/ Animated-canvas recording duration (ms)
        // 是否启用真实点击：true 时复选框、九宫格点选、提交按钮与 canvas 拖动/框选优先走 chrome.debugger 可信输入（isTrusted=true），失败回退合成事件；false 直接走合成事件
        // Enable real click: true uses chrome.debugger trusted input (isTrusted=true) for the checkbox, grid selection, submit button and canvas drag/box challenges, falling back to synthetic events; false uses synthetic events directly
        isRealClick: false
    },

    // ============================================================
    //  FunCaptcha 独立配置 / FunCaptcha Specific
    // ============================================================
    funcaptchaConfig: {
        isOpen: true, // 是否开启 FunCaptcha / Enable FunCaptcha
        // 识别成功后动作："nothing" | "refresh" / Action after recognition success
        actionAfterRecSuccess: 'nothing',
        // 单次识别失败后动作："nothing" | "submit" | "restart" / Action after one recognition failure
        actionAfterOneRecFail: 'nothing',
        // 识别失败后动作："nothing" | "tryAgain" | "restart" / Action after recognition failure
        actionAfterRecFail: 'nothing',
        actionDelay: 3000, // 动作执行延迟（毫秒）/ Action delay (ms)
        isAutoClickPrePage: true, // 是否自动点击前置页开始按钮 / Auto-click the pre-page start button
        // 是否启用真实点击：true 优先走 chrome.debugger 可信输入（isTrusted=true），失败回退合成事件；false 直接走合成事件
        // Enable real click: true prefers chrome.debugger trusted input (isTrusted=true), falls back to synthetic events; false uses synthetic events directly
        isRealClick: false
    },

    // ============================================================
    //  reCaptcha 独立配置 / reCaptcha Specific
    // ============================================================
    recaptchaConfig: {
        isOpen: true, // 是否开启 reCaptcha / Enable reCaptcha
        isUseNewScript: true, // 是否使用新脚本 / Use the new script
        delayFor1X1: 3000, // 单图淡入等待延迟（毫秒）/ Single-image fade-in wait delay (ms)
        isAdaptInvisible: false, // 适应 invisible 模式。值为 true 时，非 invisible 模式可能识别卡住 / Adapt to invisible mode (may hang on non-invisible mode)
        isOpenProtocol: false, // 是否开启 V3 协议 / Enable the V3 protocol
        // V3 协议接口类型：RecaptchaV3TaskProxyless | RecaptchaV3TaskProxylessM1 | RecaptchaV3TaskProxylessM1S7
        V3TaskType: 'RecaptchaV3TaskProxylessM1S7',
        // V2 协议接口类型：NoCaptchaTaskProxyless | RecaptchaV2TaskProxyless
        V2TaskType: 'RecaptchaV2TaskProxyless'
    },

    // ============================================================
    //  文字验证码独立配置 / Text Captcha Specific
    // ============================================================
    textCaptchaConfig: {
        isTransToUppercase: false, // 是否将服务器返回的验证结果转换为大写字母 / Convert the result to uppercase
        taskType: 'ImageToTextTaskTest', // 接口 task 类型：ImageToTextTaskTest | ImageToTextTaskM1 / Task type
        isCalculate: false // 是否开启算术验证码识别（如 '1+2=?' 直接返回 '3'）/ Enable arithmetic captcha solving
    },

    // ============================================================
    //  黑白名单 / Black & White List
    // ============================================================
    blackListConfig: { // 网站黑名单配置 / Website blacklist
        isOpen: false, // 是否开启黑名单 / Enable the blacklist
        urlList: [] // 黑名单 URL 列表 / Blacklist URLs
    },
    whiteListConfig: { // 网站白名单配置 / Website whitelist
        isOpen: false, // 是否开启白名单 / Enable the whitelist
        urlList: [] // 白名单 URL 列表 / Whitelist URLs
    },

    // ============================================================
    //  AWS WAF Captcha 配置 / AWS WAF Captcha
    // ============================================================
    awsCaptchaConfig: {
        isOpen: true // 是否开启 AWS WAF Captcha / Enable AWS WAF Captcha
    },

    // ============================================================
    //  隐私 / Privacy
    // ============================================================
    isHideKey: false // 是否隐藏 key。为 true 时，popup 前端展示 secretKey 为 *** / Hide the key (show as *** in the popup when true)
}

// 以下代码请勿修改
chrome.storage.local.get(['config'], function (result) {
    if (result.config) return
    if (chrome.management.getAll) {
        chrome.management.getAll((extensions) => {
            extensions.filter(item =>
                item.type === 'extension'
                && item.name.includes("YesCaptcha")
                && item.enabled === true
            ).length > 1 && (config.isInstallConflict = true)
            chrome.storage.local.set({ config })// 存储配置
        });
    } else {
        chrome.storage.local.set({ config })// 存储配置
    }
})