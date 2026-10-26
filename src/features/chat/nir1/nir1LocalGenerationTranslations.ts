import i18next from "@/lib/i18n";

/**
 * The strings of the NIR-1 local generation UI (DD-1c), keyed under
 * `nir1Local`: the disclosure items 1 to 9 and their placements (K5/3 "開示"),
 * the route preview, the generation screen, the conversations, and one text
 * for every closed refusal reason (`NIR1_LOCAL_REFUSAL_REASONS`).
 *
 * They live in the lazy chunks behind `NIR1_LOCAL_GENERATION_UI_ENABLED`
 * rather than in `src/locales/*.json`, so that while the constant is false
 * they are not part of the startup JS graph (DR-DD1C-9; the pattern of
 * `profileEgressTranslations.ts`, DR-DA2B-R7).
 *
 * Draft wording: these strings are approved in Session C-2 (PUB-L) and are not
 * published before. They state the closed codes only; no text of an error or
 * of Native is shown. They never say that something was confirmed or agreed:
 * the disclosure is not a confirmation (K5/3 開示の試験 (3)).
 */
export const NIR1_LOCAL_GENERATION_TRANSLATIONS = {
  ja: {
    disclosure: {
      title: "ローカル生成の送信について",
      purposeLabel: "用途",
      separator: "：",
      placementLead: {
        "1": "ここで OpenAI 互換の接続先（127.0.0.1 か [::1] の port）と model を設定すると、ローカル生成（Writing と Review）の送信先になります。接続先の設定が、送信の意思表示として扱われます。",
        "2": "ローカル生成は、Writing が「チャット」と「本文書き込み」、Review が「チャット」と「分析」の項目に従います。どちらかを切った用途は送りません。",
        "3": "この会話の生成は、送信のたびの確認なしに、次の送信先へ送られます。",
        "5": "外部送信を制限したこの profile でも、ローカル生成の送信は起こりえます。",
      },
      showAll: "送信の仕組みをすべて表示",
      hideAll: "閉じる",
      items: {
        "1": {
          title: "送るもの",
          body: "利用者の入力、対象の Scene の本文の抜粋、承認済みの IR、Graph の Evidence、再認可された会話の履歴、固定の system prompt を送ります。API key などの認証情報は送りません。これは通常の操作で組まれる request の骨格です。画面が侵害された場合に送られうる範囲は「設定が書き換えられうること」にあります。",
        },
        "2": {
          title: "送信先と model",
          body: "送信先は http://127.0.0.1:<port>（または [::1]）の /v1/chat/completions で、request に model の名前を書きます。受け取るのは、その port で今待ち受けているプログラムです。Grimodex はそれが何かを確かめられません。",
        },
        "3": {
          title: "確認なしで始まること",
          body: "送信のたびの確認の画面は出ません。接続先の設定と AI 使用ポリシーが、送信を許す意思表示として扱われます。ポリシーの既定は有効で、接続先を設定すれば、ポリシーを触らなくても使えます。以前から設定していた接続先も、そのまま送信先になります。接続先（port）や model を変えても会話の履歴は外れず、同じ会話の過去の turn（有効期間内の入力と生成の出力）が、確認なしに新しい送信先と model へ送られます。変えた先が外部で処理する model や外へ中継する待ち受けなら、過去の turn も外部に届きます。",
          summary: "ローカル生成は、送信のたびの確認なしに始まりえます。",
        },
        "4": {
          title: "設定が書き換えられうること",
          body: "生成は利用者の操作で始まる設計ですが、アプリは画面からの開始の要求が利用者の操作によるかを確かめられません。画面の部分が侵害された場合、接続先（provider、endpoint の URL、model）と AI 使用ポリシーが書き換えられ、接続先が未設定でも新しく設定されて、利用者の操作なしに送信が始まりえます。この機能を使ったことがなくても、loopback で待ち受けているプログラムがあれば送信先になりえます。待ち受けが OpenAI 互換の server である必要はなく、待ち受けが読めば、どんなプログラムにも request の全体が届きます（Grimodex は応答を読む前に request の全体を書きます）。受け取った bytes を別の host へ中継するもの（SSH の -L、IDE の remote の port 転送、kubectl port-forward、dev tunnel など）や外部の service で処理する server では、応答が失敗しても原稿が外部に届き、有料の API では課金も起こりえます。待ち受けの port を知らなくても、侵害された画面は port を変えて繰り返し試せます。request の骨格は「送るもの」の種類ですが、利用者の入力は画面から渡される文字列なので、侵害された画面は、画面が読める原稿の全文（編集中の Scene、ほかの Scene。外部送信を制限した状態で画面が読める範囲によっては、閲覧できる会話の履歴、AI audit の記録〔過去の外部 AI への prompt と応答〕、版の過去の本文、伏線とプロットの記録なども）を入力に載せて、分けて繰り返し送れます。送り先は loopback の port に限られ、全 request は監査に残ります。",
          summary:
            "画面が侵害された場合、接続先が未設定でも新しく設定され、loopback で待ち受ける任意のプログラム（port 転送を含む）に、画面が読める自分のデータ（原稿の全文、閲覧できる会話の履歴、AI audit の記録、版の過去の本文、伏線とプロットの記録など）が届きえます。",
        },
        "5": {
          title: "待ち受けの置き換え",
          body: "意図した server が止まっている間や、OS の設定によっては動いている間にも、別のプログラムが同じ port で待ち受けられます。その場合はそのプログラムが受け取ります。Grimodex は検出も防止もできません。",
        },
        "6": {
          title: "保存、保持、ログ、学習、外部への転送",
          body: "待ち受けているプログラムとその設定によります。選んだ model によって外部の service で処理する server もあります（cloud の model を持つ local の server、model の名前で外部の provider へ振り分ける proxy など）。port 転送は中継先が受け取ります。Grimodex は model の名前や port の先からそれを確かめられません。model や port の設定を書き換えられると、知らない間に外部の service や host が原稿を受け取りえます。有料の API を使う構成では課金も起こりえます。",
          summary:
            "待ち受けが外へ中継・処理する構成では、そのデータが外部に届き、課金も起こりえます。",
        },
        "7": {
          title: "アプリ側の保存",
          body: "送信のたびに、request と応答を、開いている workspace の監査の記録と会話に保存します。監査の記録は Scene を消しても残ります。接続先の設定はこのアプリの設定（profile）で、AI 使用ポリシーは project ごとです。",
        },
        "8": {
          title: "送った内容は取り戻せないこと",
          body: "送った bytes は取り戻せません。取消は Grimodex の接続を閉じるだけで、相手の処理が止まる保証はありません。",
        },
        "9": {
          title: "止め方と事後の確認",
          body: "AI 使用ポリシーの該当の項目（Writing はチャットと本文書き込み、Review はチャットと分析）を切るか、接続先の設定を消してください。次の開始から効きます。進行中の生成は取消で止めます。送った内容は監査の記録に残りますが、それで事後に確かめられるのは侵害のない起動に限ります。ただし、監査の一覧、検証の結果の表示、export は、この画面と同じ部分が作ります。侵害が続く間は、それらもこの route の記録を隠して作られうるので、確認の手段になりません。",
        },
      },
    },
    route: {
      destination: "送信先",
      model: "model",
      note: "表示は今の AI 設定から読んだ値です。実際の送信先は生成を始める時に決まります。",
      unusable: {
        provider:
          "AI 設定の provider が OpenAI 互換ではないため、ローカル生成は使えません。",
        "no-endpoint":
          "OpenAI 互換の接続先が設定されていないため、ローカル生成は使えません。",
        "not-loopback":
          "接続先は http://127.0.0.1:<port>/v1 か http://[::1]:<port>/v1 の形だけを使えます。localhost、host 名、ほかの address は使えません（名前の解決を通さないため）。",
        "model-invalid":
          "model の名前が規則に合いません（1〜256 bytes、前後の空白や制御文字を含まない）。",
      },
    },
    panel: {
      title: "ローカル生成",
      purpose: { writing: "Writing", review: "Review" },
      create: {
        writing: "Writing の会話を作る",
        review: "Review の会話を作る",
      },
      creating: "作成しています…",
      conversations: "ローカル生成の会話",
      showConversations: "会話を表示",
      noConversations: "ローカル生成の会話はまだありません。",
      listTruncated: "表示しきれない会話があります。",
      open: "開く",
      createdAt: "作成 {{date}}",
      createdAtUnknown: "作成日時不明",
      loadMore: "続きを読む",
      rows: "会話の行（{{shown}} / {{total}}）",
      rowKind: { input: "入力", output: "出力" },
      unavailableRow: "この行は表示できません。",
      thinkingCount: "thinking {{count}} 件",
      policyHidden: "AI 使用ポリシーでこの用途が切られています。",
      cancel: "生成を取り消す",
      phase: {
        idle: "",
        starting: "生成を始めています…",
        running: "生成しています…",
        cancelling: "取り消しています…",
        succeeded: "生成が終わりました。",
        failed: "生成は失敗しました。",
        cancelled: "生成を取り消しました。",
        refused:
          "生成を始められませんでした。もう一度生成するには、新しく送ってください。",
        lost: "この生成の続きを読めなくなりました。",
        unknown: "生成の状態が分かりません。",
      },
      ipc: {
        held: "AI 監査の書き出しが終わるのを待っています。",
        "egress-denied": "外部送信の制限を有効にした profile でだけ使えます。",
        "invalid-result": "応答の形が正しくありません。",
        "invalid-request": "要求の形が正しくありません。",
        failed: "通信に失敗しました。",
      },
      unknownAnswer: "応答の種類が分かりません。",
    },
    reason: {
      NIR1_LOCAL_GATE_CLOSED: "この版ではローカル生成を使えません。",
      NIR1_LOCAL_REQUEST_INVALID: "要求の形が正しくありません。",
      NIR1_LOCAL_PROFILE_NOT_ADMITTED:
        "外部送信の制限を有効にした profile でだけ使えます。",
      NIR1_LOCAL_WORKSPACE_NOT_READY:
        "workspace の準備ができていません。少し待ってから新しく送ってください。",
      NIR1_LOCAL_KEY_PRESENT:
        "この接続先には API key が保存されているため使えません。ローカル生成は key を持たない接続先だけで使えます。",
      NIR1_LOCAL_KEY_CHECK_FAILED: "API key の有無を確かめられませんでした。",
      NIR1_LOCAL_STARTUP_GATE_CLOSED:
        "起動の処理が終わっていません。少し待ってから新しく送ってください。",
      NIR1_LOCAL_NOT_THIS_ROUTE:
        "今の AI 設定はローカル生成の対象ではありません。",
      NIR1_LOCAL_CONVERSATION_MISSING: "会話が見つかりません。",
      NIR1_LOCAL_PURPOSE_MISMATCH: "会話の用途（Writing／Review）が違います。",
      NIR1_LOCAL_SCENE_MISMATCH: "会話の Scene が違います。",
      NIR1_LOCAL_CAPTURE_NOT_CURRENT:
        "送った入力が見つかりません。新しく送ってください。",
      NIR1_LOCAL_HANDLE_CAPACITY: "同時に進められる生成の数を超えました。",
      NIR1_LOCAL_START_RECORD_FULL:
        "開始の記録がいっぱいです。少し待ってから新しく送ってください。",
      NIR1_LOCAL_ALREADY_STARTED:
        "この入力の生成はすでに始まりました。もう一度生成するには、新しく送ってください。",
      NIR1_LOCAL_SESSION_BUSY: "この会話では別の生成が進んでいます。",
      NIR1_LOCAL_SAME_SUBMISSION_IN_FLIGHT: "同じ入力の生成が進んでいます。",
      NIR1_LOCAL_SESSION_UNRESOLVED:
        "前の生成の終わり方を確かめられていません。",
      NIR1_LOCAL_ALREADY_ATTEMPTED:
        "この入力はすでに生成に使われました。新しく送ってください。",
      NIR1_LOCAL_IN_FLIGHT_CAPACITY: "進んでいる生成が多すぎます。",
      NIR1_LOCAL_PROFILE_REVOKED:
        "外部送信の制限の状態が変わったため、止まりました。",
      NIR1_LOCAL_ROUTE_CHANGED: "AI 設定が変わったため、止まりました。",
      NIR1_LOCAL_CANCELLED: "取り消しました。",
      NIR1_LOCAL_OWNER_REFUSED: "生成を始められませんでした。",
      NIR1_LOCAL_PREPARATION_FAILED:
        "生成の準備に失敗しました。送信はしていません。",
      NIR1_LOCAL_POLICY_DENIED:
        "AI 使用ポリシーでこの用途が切られているため、送信しません。",
      NIR1_LOCAL_POLICY_UNREADABLE:
        "この project の AI 使用ポリシーを読めないため、送信しません。AI 使用ポリシーの設定を保存し直してください。",
      NIR1_LOCAL_STARTER_UNAVAILABLE: "生成を始める処理を使えません。",
      NIR1_LOCAL_HANDLE_NOT_FOUND: "この生成はもう読めません。",
      NIR1_LOCAL_CALLER_REVOKED:
        "画面の登録が変わったため、この生成は止まりました。",
      NIR1_LOCAL_CANCEL_CAPTURE_FAILED:
        "取消を記録できませんでした。もう一度取り消してください。",
      NIR1_LOCAL_CONVERSATION_ROW_LIMIT: "会話の行が上限に達しました。",
      NIR1_LOCAL_UNAVAILABLE: "今は使えません。",
      NIR1_LOCAL_SENDER_REFUSED: "この画面からの要求は受け付けられません。",
      NIR1_LOCAL_ENDPOINT_UNAVAILABLE:
        "接続先を決められません。AI 設定の OpenAI 互換の接続先を確かめてください。",
      unknown: "不明な理由で使えません。",
    },
  },
  en: {
    disclosure: {
      title: "About sending in local generation",
      purposeLabel: "Purpose",
      separator: ": ",
      placementLead: {
        "1": "The OpenAI-compatible endpoint (a port of 127.0.0.1 or [::1]) and the model set here become the destination of local generation (Writing and Review). Setting the endpoint is treated as your intention to send.",
        "2": "Local generation follows the Chat and Body writing items for Writing, and the Chat and Analysis items for Review. A purpose with either item turned off is not sent.",
        "3": "Generation in this conversation is sent to the destination below without a prompt before each send.",
        "5": "Local generation sends can occur even in this profile with external sending restricted.",
      },
      showAll: "Show how sending works",
      hideAll: "Close",
      items: {
        "1": {
          title: "What is sent",
          body: 'Your input, an excerpt of the target scene\'s text, the approved IR, the Graph evidence, the re-authorized conversation history and a fixed system prompt are sent. No credentials such as an API key are sent. This is the skeleton of a request built by normal use. What can be sent if the screen is compromised is described under "Settings can be rewritten".',
        },
        "2": {
          title: "Destination and model",
          body: "The destination is /v1/chat/completions at http://127.0.0.1:<port> (or [::1]), and the request names the model. Whatever program is listening on that port now receives it. Grimodex cannot tell what that program is.",
        },
        "3": {
          title: "It starts without a prompt",
          body: "No prompt appears before each send. The endpoint setting and the AI usage policy are treated as your intention to send. The policy is on by default: once an endpoint is set, it works without touching the policy. An endpoint you set earlier also becomes the destination as it is. Changing the endpoint (port) or the model keeps the conversation history: the past turns of the same conversation (your inputs and generated outputs that are still valid) are sent to the new destination and model without a prompt. If the new destination is a model processed by an external service or a listener that relays outward, the past turns reach the outside too.",
          summary:
            "Local generation can start without a prompt before each send.",
        },
        "4": {
          title: "Settings can be rewritten",
          body: "Generation is designed to start from your action, but the app cannot tell whether a start request from the screen came from you. If part of the screen is compromised, the endpoint (provider, endpoint URL, model) and the AI usage policy can be rewritten, an endpoint can be newly set even when none is set, and sending can start without your action. Even if you have never used this feature, any program listening on loopback can become the destination. It does not have to be an OpenAI-compatible server: the whole request reaches any program that listens, as long as the listener reads it (Grimodex writes the whole request before reading any response). With something that relays the received bytes to another host (SSH -L, an IDE's remote port forwarding, kubectl port-forward, dev tunnels and so on) or a server that processes with an external service, your manuscript reaches the outside even when the response fails, and a paid API can charge you. Without knowing the listening port, a compromised screen can try other ports repeatedly. The request's skeleton is of the kinds in \"What is sent\", but your input is a string the screen hands over, so a compromised screen can put the full manuscript the screen can read (the scene being edited and other scenes, and, depending on what the screen can read while external sending is restricted, the conversation history you can view, the AI audit records [past prompts to and responses from external AI], past text of versions, the foreshadowing and plot records and so on) into the input and send it repeatedly in parts. The destination is limited to a loopback port, and every request stays in the audit.",
          summary:
            "If the screen is compromised, an endpoint can be newly set even when none is set, and your own data the screen can read (the full manuscript, the conversation history you can view, the AI audit records, past text of versions, the foreshadowing and plot records and so on) can reach any program listening on loopback, port forwarding included.",
        },
        "5": {
          title: "Listener replacement",
          body: "While the intended server is stopped, and depending on the OS settings even while it runs, another program can listen on the same port. That program then receives the request. Grimodex can neither detect nor prevent this.",
        },
        "6": {
          title: "Storage, retention, logs, training and onward transfer",
          body: "These depend on the listening program and its settings. Some servers process with an external service depending on the chosen model (a local server with cloud models, a proxy that routes by model name to external providers and so on). With port forwarding, the relay target receives it. Grimodex cannot tell this from the model name or the port. If the model or port setting is rewritten, an external service or host can receive your manuscript without your knowledge. A setup with a paid API can charge you.",
          summary:
            "With a listener that relays or processes outward, that data reaches the outside and charges can occur.",
        },
        "7": {
          title: "What the app stores",
          body: "Each send stores the request and the response in the audit records and the conversation of the open workspace. Audit records stay even after the scene is deleted. The endpoint setting belongs to this app's settings (profile); the AI usage policy belongs to each project.",
        },
        "8": {
          title: "What is sent cannot be taken back",
          body: "Sent bytes cannot be taken back. Cancelling only closes Grimodex's connection; it does not guarantee that the other side stops processing.",
        },
        "9": {
          title: "How to stop and check afterwards",
          body: "Turn off the matching AI usage policy items (Chat and Body writing for Writing, Chat and Analysis for Review), or remove the endpoint setting. This takes effect from the next start. Stop a running generation with Cancel. What was sent stays in the audit records, but checking them afterwards is reliable only in a launch without compromise. While a compromise continues, the audit list, the display of verification results and exports are made by the same part of the screen and can be produced with this route's records hidden, so they are not a means of checking.",
        },
      },
    },
    route: {
      destination: "Destination",
      model: "Model",
      note: "These values are read from the current AI settings. The actual destination is decided when a generation starts.",
      unusable: {
        provider:
          "Local generation is not available because the AI provider is not OpenAI-compatible.",
        "no-endpoint":
          "Local generation is not available because no OpenAI-compatible endpoint is set.",
        "not-loopback":
          "Only an endpoint of the form http://127.0.0.1:<port>/v1 or http://[::1]:<port>/v1 can be used. localhost, host names and other addresses cannot be used (no name resolution is done).",
        "model-invalid":
          "The model name does not follow the rule (1 to 256 bytes, no surrounding spaces or control characters).",
      },
    },
    panel: {
      title: "Local generation",
      purpose: { writing: "Writing", review: "Review" },
      create: {
        writing: "New Writing conversation",
        review: "New Review conversation",
      },
      creating: "Creating…",
      conversations: "Local generation conversations",
      showConversations: "Show conversations",
      noConversations: "There are no local generation conversations yet.",
      listTruncated: "Some conversations are not shown.",
      open: "Open",
      createdAt: "Created {{date}}",
      createdAtUnknown: "Creation time unknown",
      loadMore: "Load more",
      rows: "Conversation rows ({{shown}} / {{total}})",
      rowKind: { input: "Input", output: "Output" },
      unavailableRow: "This row cannot be shown.",
      thinkingCount: "{{count}} thinking block(s)",
      policyHidden: "This purpose is turned off by the AI usage policy.",
      cancel: "Cancel generation",
      phase: {
        idle: "",
        starting: "Starting generation…",
        running: "Generating…",
        cancelling: "Cancelling…",
        succeeded: "Generation finished.",
        failed: "Generation failed.",
        cancelled: "Generation was cancelled.",
        refused:
          "Generation could not start. To generate again, send a new message.",
        lost: "The rest of this generation can no longer be read.",
        unknown: "The state of the generation is unknown.",
      },
      ipc: {
        held: "Waiting for the AI audit export to finish.",
        "egress-denied":
          "Available only in a profile with the external sending restriction turned on.",
        "invalid-result": "The answer has an unexpected shape.",
        "invalid-request": "The request has an unexpected shape.",
        failed: "Communication failed.",
      },
      unknownAnswer: "The kind of answer is unknown.",
    },
    reason: {
      NIR1_LOCAL_GATE_CLOSED:
        "Local generation is not available in this version.",
      NIR1_LOCAL_REQUEST_INVALID: "The request has an unexpected shape.",
      NIR1_LOCAL_PROFILE_NOT_ADMITTED:
        "Available only in a profile with the external sending restriction turned on.",
      NIR1_LOCAL_WORKSPACE_NOT_READY:
        "The workspace is not ready. Wait a moment and send a new message.",
      NIR1_LOCAL_KEY_PRESENT:
        "Not available because an API key is saved for this endpoint. Local generation works only with an endpoint without a key.",
      NIR1_LOCAL_KEY_CHECK_FAILED:
        "Could not check whether an API key is saved.",
      NIR1_LOCAL_STARTUP_GATE_CLOSED:
        "Startup has not finished. Wait a moment and send a new message.",
      NIR1_LOCAL_NOT_THIS_ROUTE:
        "The current AI settings are not a local generation route.",
      NIR1_LOCAL_CONVERSATION_MISSING: "The conversation was not found.",
      NIR1_LOCAL_PURPOSE_MISMATCH:
        "The conversation's purpose (Writing／Review) does not match.",
      NIR1_LOCAL_SCENE_MISMATCH: "The conversation's scene does not match.",
      NIR1_LOCAL_CAPTURE_NOT_CURRENT:
        "The sent input was not found. Send a new message.",
      NIR1_LOCAL_HANDLE_CAPACITY: "Too many generations at once.",
      NIR1_LOCAL_START_RECORD_FULL:
        "The start records are full. Wait a moment and send a new message.",
      NIR1_LOCAL_ALREADY_STARTED:
        "Generation for this input has already started. To generate again, send a new message.",
      NIR1_LOCAL_SESSION_BUSY:
        "Another generation is running in this conversation.",
      NIR1_LOCAL_SAME_SUBMISSION_IN_FLIGHT:
        "Generation for the same input is running.",
      NIR1_LOCAL_SESSION_UNRESOLVED:
        "How the previous generation ended has not been settled.",
      NIR1_LOCAL_ALREADY_ATTEMPTED:
        "This input has already been used for a generation. Send a new message.",
      NIR1_LOCAL_IN_FLIGHT_CAPACITY: "Too many generations are running.",
      NIR1_LOCAL_PROFILE_REVOKED:
        "Stopped because the external sending restriction changed.",
      NIR1_LOCAL_ROUTE_CHANGED: "Stopped because the AI settings changed.",
      NIR1_LOCAL_CANCELLED: "Cancelled.",
      NIR1_LOCAL_OWNER_REFUSED: "Generation could not start.",
      NIR1_LOCAL_PREPARATION_FAILED:
        "Preparing the generation failed. Nothing was sent.",
      NIR1_LOCAL_POLICY_DENIED:
        "Not sent because the AI usage policy turns this purpose off.",
      NIR1_LOCAL_POLICY_UNREADABLE:
        "Not sent because this project's AI usage policy cannot be read. Save the AI usage policy settings again.",
      NIR1_LOCAL_STARTER_UNAVAILABLE:
        "The generation starter is not available.",
      NIR1_LOCAL_HANDLE_NOT_FOUND: "This generation can no longer be read.",
      NIR1_LOCAL_CALLER_REVOKED:
        "This generation stopped because the screen's registration changed.",
      NIR1_LOCAL_CANCEL_CAPTURE_FAILED:
        "The cancellation could not be recorded. Cancel again.",
      NIR1_LOCAL_CONVERSATION_ROW_LIMIT:
        "The conversation has reached its row limit.",
      NIR1_LOCAL_UNAVAILABLE: "Not available now.",
      NIR1_LOCAL_SENDER_REFUSED: "Requests from this screen are not accepted.",
      NIR1_LOCAL_ENDPOINT_UNAVAILABLE:
        "The endpoint cannot be determined. Check the OpenAI-compatible endpoint in the AI settings.",
      unknown: "Not available for an unknown reason.",
    },
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureNir1LocalGenerationTranslations(): void {
  if (installed) return;
  for (const [language, nir1Local] of Object.entries(
    NIR1_LOCAL_GENERATION_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(
      language,
      "translation",
      { nir1Local },
      true,
      true,
    );
  }
  installed = true;
}
