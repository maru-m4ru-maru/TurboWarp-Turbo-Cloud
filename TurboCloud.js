(function (Scratch) {
    "use strict";

    if (!Scratch.extensions.unsandboxed) {
        throw new Error("TurboCloud v0.6.0 はunsandboxedモードが必要です。");
    }

    const vm = Scratch.vm || window.vm;

    if (!vm) {
        throw new Error("TurboCloud: VMが見つかりません。");
    }

    const runtime = vm.runtime;

    if (!runtime) {
        throw new Error("TurboCloud: Runtimeが見つかりません。");
    }

    const VERSION = "0.6.0";
    const PREFIX = "☁ tc_";
    const BUFFER_INTERVAL = 100;

    const creatingVariables = new Map();
    const cloudBuffer = new Map();

    let bufferTimer = null;
    let flushing = false;

    function normalizeName(name) {
        name = String(name ?? "").trim();

        if (name.startsWith(PREFIX)) {
            return name.slice(PREFIX.length);
        }

        if (name.startsWith("☁")) {
            name = name.slice(1).trim();

            if (name.startsWith("tc_")) {
                return name.slice(3);
            }
        }

        if (name.startsWith("tc_")) {
            return name.slice(3);
        }

        return name;
    }

    function cloudName(name) {
        return PREFIX + normalizeName(name);
    }

    function getStage() {
        if (!Array.isArray(runtime.targets)) {
            return null;
        }

        return runtime.targets.find(target => target.isStage) || null;
    }

    function findVariable(name) {
        const stage = getStage();

        if (!stage || !stage.variables) {
            return null;
        }

        const fullName = cloudName(name);

        for (const variable of Object.values(stage.variables)) {
            if (variable && variable.name === fullName) {
                return variable;
            }
        }

        return null;
    }

    function findCloudVariable(name) {
        const variable = findVariable(name);

        if (variable && variable.isCloud === true) {
            return variable;
        }

        return null;
    }

    function getWorkspace() {
        const SB = window.ScratchBlocks;

        if (!SB) {
            return null;
        }

        if (typeof SB.getMainWorkspace === "function") {
            return SB.getMainWorkspace();
        }

        return SB.mainWorkspace || null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function ensureCloudVariable(name, initialValue = "0") {
        name = normalizeName(name);

        if (!name) {
            throw new Error("データ名が空です。");
        }

        const fullName = cloudName(name);
        const existing = findVariable(name);

        if (existing) {
            if (existing.isCloud === true) {
                return existing;
            }

            throw new Error(`「${fullName}」は通常の変数として存在します。`);
        }

        if (creatingVariables.has(fullName)) {
            return await creatingVariables.get(fullName);
        }

        const task = (async () => {
            const workspace = getWorkspace();

            if (!workspace) {
                throw new Error("ScratchBlocksのWorkspaceが見つかりません。");
            }

            if (
                typeof runtime.canAddCloudVariable === "function" &&
                !runtime.canAddCloudVariable()
            ) {
                throw new Error("クラウド変数をこれ以上追加できません。");
            }

            console.log(
                "☁ TurboCloud:",
                fullName,
                "を作成します..."
            );

            workspace.createVariable(
                fullName,
                "",
                null,
                false,
                true
            );

            for (let i = 0; i < 50; i++) {
                const variable = findVariable(name);

                if (variable) {
                    if (variable.isCloud !== true) {
                        throw new Error(
                            `「${fullName}」は作成されましたが、クラウド変数として認識されていません。`
                        );
                    }

                    variable.value = String(initialValue ?? "0");

                    console.log(
                        "✅ クラウド変数作成成功:",
                        variable
                    );

                    return variable;
                }

                await sleep(20);
            }

            throw new Error(
                `「${fullName}」の作成後、VMへの反映を確認できませんでした。`
            );
        })();

        creatingVariables.set(fullName, task);

        try {
            return await task;
        }
        finally {
            creatingVariables.delete(fullName);
        }
    }

    function deleteCloudVariable(name) {
        name = normalizeName(name);

        if (!name) {
            return false;
        }

        const variable = findCloudVariable(name);

        if (!variable) {
            console.log(
                "☁ TurboCloud:",
                cloudName(name),
                "は存在しません。"
            );

            return false;
        }

        const workspace = getWorkspace();

        if (!workspace) {
            throw new Error("ScratchBlocksのWorkspaceが見つかりません。");
        }

        if (typeof workspace.deleteVariableById !== "function") {
            throw new Error(
                "WorkspaceのdeleteVariableByIdが見つかりません。"
            );
        }

        cloudBuffer.delete(variable.name);

        console.log(
            "🗑️ TurboCloud:",
            variable.name,
            "を削除します..."
        );

        workspace.deleteVariableById(variable.id);

        return true;
    }

    function getCloudIO() {
        return (runtime.ioDevices && runtime.ioDevices.cloud) || null;
    }

    function transmitCloudValue(variable, value) {
        if (!variable || variable.isCloud !== true) {
            return false;
        }

        const newValue = String(value);
        variable.value = newValue;

        const cloud = getCloudIO();

        if (
            cloud &&
            typeof cloud.requestUpdateVariable === "function"
        ) {
            cloud.requestUpdateVariable(
                variable.name,
                newValue
            );

            return true;
        }

        console.warn(
            "TurboCloud: Cloud I/Oが利用できません。"
        );

        return false;
    }

    function bufferCloudValue(variable, value) {
        if (!variable || variable.isCloud !== true) {
            return false;
        }

        const newValue = String(value);

        variable.value = newValue;

        cloudBuffer.set(variable.name, {
            variable: variable,
            value: newValue
        });

        scheduleBufferFlush();

        return true;
    }

    function scheduleBufferFlush() {
        if (bufferTimer !== null) {
            return;
        }

        if (cloudBuffer.size === 0) {
            return;
        }

        bufferTimer = setTimeout(() => {
            bufferTimer = null;
            flushCloudBuffer();
        }, BUFFER_INTERVAL);
    }

    function flushCloudBuffer() {
        if (flushing) {
            return;
        }

        if (cloudBuffer.size === 0) {
            return;
        }

        flushing = true;

        const batch = Array.from(cloudBuffer.values());

        cloudBuffer.clear();

        let sent = 0;

        try {
            for (const item of batch) {
                const variable = item.variable;

                if (!variable || variable.isCloud !== true) {
                    continue;
                }

                const success = transmitCloudValue(
                    variable,
                    item.value
                );

                if (success) {
                    sent++;
                }
            }

            if (sent > 0) {
                console.log(
                    `☁ TurboCloud: ${sent}件の変更を送信しました。`
                );
            }
        }
        catch (error) {
            console.error(
                "TurboCloud: バッファ送信失敗:",
                error
            );
        }
        finally {
            flushing = false;

            if (cloudBuffer.size > 0) {
                scheduleBufferFlush();
            }
        }
    }

    function textToBytes(text) {
        return new TextEncoder().encode(String(text));
    }

    function bytesToText(bytes) {
        return new TextDecoder().decode(bytes);
    }

    function compressBytes(input) {
        const data = input instanceof Uint8Array
            ? input
            : new Uint8Array(input);

        const output = [];

        output.push(0x54);

        output.push((data.length >>> 24) & 0xff);
        output.push((data.length >>> 16) & 0xff);
        output.push((data.length >>> 8) & 0xff);
        output.push(data.length & 0xff);

        const positions = new Map();

        let position = 0;

        while (position < data.length) {
            const flagIndex = output.length;

            output.push(0);

            let flags = 0;

            for (
                let token = 0;
                token < 8 && position < data.length;
                token++
            ) {
                let bestDistance = 0;
                let bestLength = 0;

                let list = null;
                let key = null;

                if (position + 2 < data.length) {
                    key = (
                        (data[position] << 16) |
                        (data[position + 1] << 8) |
                        data[position + 2]
                    ) >>> 0;

                    list = positions.get(key);

                    if (list) {
                        let checked = 0;

                        for (
                            let i = list.length - 1;
                            i >= 0 && checked < 32;
                            i--, checked++
                        ) {
                            const candidate = list[i];

                            const distance = position - candidate;

                            if (
                                distance <= 0 ||
                                distance > 4096
                            ) {
                                continue;
                            }

                            let length = 0;

                            while (
                                length < 18 &&
                                position + length < data.length &&
                                candidate + length < position &&
                                data[candidate + length] ===
                                    data[position + length]
                            ) {
                                length++;
                            }

                            if (
                                length >= 3 &&
                                length > bestLength
                            ) {
                                bestLength = length;
                                bestDistance = distance;

                                if (length === 18) {
                                    break;
                                }
                            }
                        }
                    }

                    if (!list) {
                        list = [position];
                        positions.set(key, list);
                    }
                    else {
                        list.push(position);

                        if (list.length > 64) {
                            list.shift();
                        }
                    }
                }

                if (bestLength >= 3) {
                    flags |= 1 << token;

                    const distanceCode = bestDistance - 1;
                    const lengthCode = bestLength - 3;

                    const packed =
                        (distanceCode << 4) |
                        lengthCode;

                    output.push(
                        (packed >>> 8) & 0xff,
                        packed & 0xff
                    );

                    for (
                        let i = 1;
                        i < bestLength;
                        i++
                    ) {
                        const p = position + i;

                        if (p + 2 < data.length) {
                            const matchKey = (
                                (data[p] << 16) |
                                (data[p + 1] << 8) |
                                data[p + 2]
                            ) >>> 0;

                            let matchList =
                                positions.get(matchKey);

                            if (!matchList) {
                                matchList = [];
                                positions.set(
                                    matchKey,
                                    matchList
                                );
                            }

                            matchList.push(p);

                            if (matchList.length > 64) {
                                matchList.shift();
                            }
                        }
                    }

                    position += bestLength;
                }
                else {
                    output.push(data[position]);
                    position++;
                }
            }

            output[flagIndex] = flags;
        }

        return new Uint8Array(output);
    }

    function decompressBytes(input) {
        const data = input instanceof Uint8Array
            ? input
            : new Uint8Array(input);

        if (data.length < 5) {
            throw new Error("圧縮データが短すぎます。");
        }

        if (data[0] !== 0x54) {
            throw new Error(
                "未知のTurboCloud圧縮形式です。"
            );
        }

        const originalLength = (
            (data[1] << 24) |
            (data[2] << 16) |
            (data[3] << 8) |
            data[4]
        ) >>> 0;

        const output = [];

        let position = 5;

        while (
            position < data.length &&
            output.length < originalLength
        ) {
            const flags = data[position++];

            for (
                let token = 0;
                token < 8 && output.length < originalLength;
                token++
            ) {
                const isMatch =
                    (flags & (1 << token)) !== 0;

                if (!isMatch) {
                    if (position >= data.length) {
                        throw new Error(
                            "圧縮データが途中で終わっています。"
                        );
                    }

                    output.push(data[position++]);

                    continue;
                }

                if (position + 1 >= data.length) {
                    throw new Error(
                        "圧縮データの参照情報が壊れています。"
                    );
                }

                const packed = (
                    (data[position] << 8) |
                    data[position + 1]
                ) >>> 0;

                position += 2;

                const distance =
                    (packed >>> 4) + 1;

                const length =
                    (packed & 0x0f) + 3;

                if (distance > output.length) {
                    throw new Error(
                        "圧縮データの距離が不正です。"
                    );
                }

                const start = output.length - distance;

                for (
                    let i = 0;
                    i < length &&
                    output.length < originalLength;
                    i++
                ) {
                    output.push(output[start + i]);
                }
            }
        }

        if (output.length !== originalLength) {
            throw new Error(
                "圧縮データを正しく復元できませんでした。"
            );
        }

        return new Uint8Array(output);
    }

    function packBytesToDecimal(bytes) {
        let result = "";

        for (let i = 0; i < bytes.length; i += 3) {
            const b0 = bytes[i] ?? 0;
            const b1 = bytes[i + 1] ?? 0;
            const b2 = bytes[i + 2] ?? 0;

            const value = (
                (b0 << 16) |
                (b1 << 8) |
                b2
            ) >>> 0;

            result += String(value).padStart(8, "0");
        }

        return result;
    }

    function unpackDecimalToBytes(decimal, byteLength) {
        decimal = String(decimal ?? "");

        if (byteLength === 0) {
            return new Uint8Array(0);
        }

        if (!/^\d+$/.test(decimal)) {
            throw new Error(
                "クラウドデータに数字以外の文字があります。"
            );
        }

        const requiredDigits =
            Math.ceil(byteLength / 3) * 8;

        if (decimal.length < requiredDigits) {
            throw new Error(
                "クラウドデータの長さが不足しています。"
            );
        }

        const output = new Uint8Array(byteLength);

        let outputIndex = 0;

        for (
            let i = 0;
            i < requiredDigits &&
            outputIndex < byteLength;
            i += 8
        ) {
            const chunk = decimal.slice(i, i + 8);
            const value = Number(chunk);

            if (
                !Number.isSafeInteger(value) ||
                value < 0 ||
                value > 16777215
            ) {
                throw new Error(
                    "数字パックの値が不正です。"
                );
            }

            const b0 = (value >>> 16) & 0xff;
            const b1 = (value >>> 8) & 0xff;
            const b2 = value & 0xff;

            output[outputIndex++] = b0;

            if (outputIndex < byteLength) {
                output[outputIndex++] = b1;
            }

            if (outputIndex < byteLength) {
                output[outputIndex++] = b2;
            }
        }

        return output;
    }

    function encodeForCloud(text) {
        const originalBytes = textToBytes(text);
        const compressedBytes = compressBytes(originalBytes);

        const rawPacked =
            packBytesToDecimal(originalBytes);

        const compressedPacked =
            packBytesToDecimal(compressedBytes);

        const rawData =
            "0" +
            String(originalBytes.length).padStart(8, "0") +
            rawPacked;

        const compressedData =
            "1" +
            String(compressedBytes.length).padStart(8, "0") +
            compressedPacked;

        if (compressedData.length < rawData.length) {
            return {
                data: compressedData,
                compressed: true,
                originalBytes: originalBytes.length,
                storedBytes: compressedBytes.length,
                digits: compressedData.length
            };
        }

        return {
            data: rawData,
            compressed: false,
            originalBytes: originalBytes.length,
            storedBytes: originalBytes.length,
            digits: rawData.length
        };
    }

    function decodeFromCloud(data) {
        data = String(data ?? "");

        if (data.length < 9) {
            throw new Error("クラウドデータが短すぎます。");
        }

        const mode = data[0];

        const storedByteLength = Number(
            data.slice(1, 9)
        );

        if (
            !Number.isSafeInteger(storedByteLength) ||
            storedByteLength < 0
        ) {
            throw new Error(
                "データサイズ情報が不正です。"
            );
        }

        const packed = data.slice(9);

        const bytes = unpackDecimalToBytes(
            packed,
            storedByteLength
        );

        if (mode === "1") {
            const decompressed = decompressBytes(bytes);
            return bytesToText(decompressed);
        }

        if (mode === "0") {
            return bytesToText(bytes);
        }

        throw new Error(
            "未知のTurboCloudデータ形式です。"
        );
    }

    function calculateStats(text) {
        const result = encodeForCloud(text);
        const original = result.originalBytes;
        const digits = result.digits;

        const ratio = original > 0
            ? (digits / original) * 100
            : 0;

        return {
            compressed: result.compressed,
            originalBytes: result.originalBytes,
            storedBytes: result.storedBytes,
            cloudDigits: result.digits,
            ratio: ratio
        };
    }

    class TurboCloud {
        getInfo() {
            return {
                id: "turbocloud",
                name: "TurboCloud",

                color1: "#20a060",
                color2: "#18804b",
                color3: "#106438",

                blocks: [
                    {
                        opcode: "setData",
                        blockType: Scratch.BlockType.COMMAND,
                        text: "TurboCloudのデータ [NAME] を [VALUE] にする",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "score"
                            },
                            VALUE: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "123"
                            }
                        }
                    },

                    {
                        opcode: "flushBuffer",
                        blockType: Scratch.BlockType.COMMAND,
                        text: "TurboCloudのバッファを今すぐ送信"
                    },

                    {
                        opcode: "getData",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "TurboCloudのデータ [NAME]",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "score"
                            }
                        }
                    },

                    {
                        opcode: "createData",
                        blockType: Scratch.BlockType.COMMAND,
                        text: "TurboCloudのデータ [NAME] を作る",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "score"
                            }
                        }
                    },

                    {
                        opcode: "deleteData",
                        blockType: Scratch.BlockType.COMMAND,
                        text: "TurboCloudのデータ [NAME] を削除する",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "score"
                            }
                        }
                    },

                    {
                        opcode: "sendCompressed",
                        blockType: Scratch.BlockType.COMMAND,
                        text: "TurboCloudのデータ [NAME] に [TEXT] を圧縮して送る",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "message"
                            },
                            TEXT: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "Hello World!"
                            }
                        }
                    },

                    {
                        opcode: "receiveCompressed",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "TurboCloudのデータ [NAME] を復元",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "message"
                            }
                        }
                    },

                    {
                        opcode: "getCompressedData",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "TurboCloudの圧縮データ [NAME]",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "message"
                            }
                        }
                    },

                    {
                        opcode: "compressionRatio",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "TurboCloudの圧縮データ長 [NAME]",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "message"
                            }
                        }
                    },

                    {
                        opcode: "compressText",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "文字列 [TEXT] をTurboCloud形式に圧縮",
                        arguments: {
                            TEXT: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "Hello Hello Hello Hello"
                            }
                        }
                    },

                    {
                        opcode: "decompressText",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "TurboCloud形式 [DATA] を復元",
                        arguments: {
                            DATA: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "123"
                            }
                        }
                    },

                    {
                        opcode: "compressionStats",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "文字列 [TEXT] のクラウド長",
                        arguments: {
                            TEXT: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "Hello World"
                            }
                        }
                    },

                    {
                        opcode: "dataExists",
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: "TurboCloudのデータ [NAME] が存在する？",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "message"
                            }
                        }
                    },

                    {
                        opcode: "isCloudData",
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: "TurboCloudのデータ [NAME] はクラウド変数？",
                        arguments: {
                            NAME: {
                                type: Scratch.ArgumentType.STRING,
                                defaultValue: "message"
                            }
                        }
                    },

                    {
                        opcode: "version",
                        blockType: Scratch.BlockType.REPORTER,
                        text: "TurboCloudのバージョン"
                    }
                ]
            };
        }

        setData(args) {
            const name = normalizeName(args.NAME);
            const variable = findVariable(name);

            if (!variable) {
                return;
            }

            if (variable.isCloud !== true) {
                return;
            }

            bufferCloudValue(
                variable,
                String(args.VALUE ?? "")
            );
        }

        flushBuffer() {
            if (bufferTimer !== null) {
                clearTimeout(bufferTimer);
                bufferTimer = null;
            }

            flushCloudBuffer();
        }

        getData(args) {
            const name = normalizeName(args.NAME);
            const variable = findVariable(name);

            return variable ? variable.value : "";
        }

        createData(args) {
            ensureCloudVariable(
                args.NAME,
                "0"
            ).catch(error => {
                console.error(
                    "TurboCloud:",
                    error
                );
            });
        }

        deleteData(args) {
            try {
                deleteCloudVariable(args.NAME);
            }
            catch (error) {
                console.error(
                    "TurboCloud:",
                    error
                );
            }
        }

        sendCompressed(args) {
            const name = normalizeName(args.NAME);
            const text = String(args.TEXT ?? "");

            let encoded;

            try {
                encoded = encodeForCloud(text);
            }
            catch (error) {
                console.error(
                    "TurboCloud: 圧縮失敗:",
                    error
                );

                return;
            }

            ensureCloudVariable(
                name,
                "0"
            )
                .then(variable => {
                    bufferCloudValue(
                        variable,
                        encoded.data
                    );

                    console.log(
                        "☁ TurboCloud 圧縮送信待ち",
                        {
                            name: variable.name,
                            compressed: encoded.compressed,
                            originalBytes: encoded.originalBytes,
                            storedBytes: encoded.storedBytes,
                            cloudDigits: encoded.digits,
                            data: encoded.data
                        }
                    );
                })
                .catch(error => {
                    console.error(
                        "TurboCloud:",
                        error
                    );
                });
        }

        receiveCompressed(args) {
            const name = normalizeName(args.NAME);
            const variable = findCloudVariable(name);

            if (!variable) {
                return "";
            }

            try {
                return decodeFromCloud(
                    String(variable.value ?? "")
                );
            }
            catch (error) {
                console.warn(
                    "TurboCloud: 復元失敗:",
                    error
                );

                return "";
            }
        }

        getCompressedData(args) {
            const name = normalizeName(args.NAME);
            const variable = findCloudVariable(name);

            return variable ? variable.value : "";
        }

        compressionRatio(args) {
            const name = normalizeName(args.NAME);
            const variable = findCloudVariable(name);

            if (!variable) {
                return 0;
            }

            return String(variable.value ?? "").length;
        }

        compressText(args) {
            try {
                const encoded = encodeForCloud(
                    String(args.TEXT ?? "")
                );

                return encoded.data;
            }
            catch (error) {
                console.warn(
                    "TurboCloud: 圧縮失敗:",
                    error
                );

                return "";
            }
        }

        decompressText(args) {
            try {
                return decodeFromCloud(
                    String(args.DATA ?? "")
                );
            }
            catch (error) {
                console.warn(
                    "TurboCloud: 復元失敗:",
                    error
                );

                return "";
            }
        }

        compressionStats(args) {
            const text = String(args.TEXT ?? "");

            try {
                const stats = calculateStats(text);

                return [
                    "圧縮:",
                    stats.compressed ? "ON" : "OFF",
                    "元バイト:",
                    stats.originalBytes,
                    "保存バイト:",
                    stats.storedBytes,
                    "クラウド桁数:",
                    stats.cloudDigits,
                    "比率:",
                    stats.ratio.toFixed(1) + "%"
                ].join(" ");
            }
            catch (error) {
                return "圧縮エラー";
            }
        }

        dataExists(args) {
            return !!findVariable(args.NAME);
        }

        isCloudData(args) {
            return !!findCloudVariable(args.NAME);
        }

        version() {
            return VERSION;
        }
    }

    Scratch.extensions.register(
        new TurboCloud()
    );

    console.log(
        `%cTurboCloud v${VERSION} loaded`,
        "font-size:16px;font-weight:bold;"
    );

    console.log("☁ 100msバッファリング対応");
    console.log("📦 同一変数の変更を自動統合");
    console.log("⚡ 手動フラッシュ対応");
    console.log("🗑️ クラウド変数削除対応");
})(Scratch);
