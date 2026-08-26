const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RM_TYPES = ["ถั่วเหลือง/เมล็ดธัญพืช","น้ำตาล/สารให้ความหวาน","สารแต่งกลิ่น","สารแต่งสี","สารคงตัว/อิมัลซิไฟเออร์","นมผง/ผลิตภัณฑ์นม","วิตามิน/แร่ธาตุ","สารกันเสีย","เกลือ/สารปรุงรส","บรรจุภัณฑ์","อื่นๆ"];
const ALLERGENS = ["ไม่มี","ถั่วเหลือง","นม","ถั่วลิสง","ถั่วเปลือกแข็ง","กลูเตน/ข้าวสาลี","งา","ไข่","อื่นๆ"];
const UNITS = ["กก.","กรัม","ลิตร","มล.","ขวด","ลัง","ถุง"];

const PROMPT = `คุณเป็นผู้ช่วยฝ่าย R&D โรงงานนมถั่วเหลือง อ่านรูปฉลากวัตถุดิบแล้วดึงข้อมูลออกมาเป็น JSON

กฎสำคัญ (ห้ามฝ่าฝืน):
1. ดึงเฉพาะสิ่งที่ "เห็นบนฉลากจริง" เท่านั้น ห้ามเดา ห้ามเติมจากความรู้ทั่วไป
2. ช่องไหนไม่เห็นบนฉลาก ให้ใส่ค่าว่าง ""
3. allergen (สารก่อภูมิแพ้) = ข้อมูลความปลอดภัยอาหาร ห้ามเดาเด็ดขาด
   - ใส่ "ไม่มี" เฉพาะเมื่อฉลากเขียนชัดว่า Non Allergen / No allergen / ไม่มีสารก่อภูมิแพ้
   - ถ้าฉลากระบุสารก่อภูมิแพ้ ให้เลือกจาก: ${ALLERGENS.join(" / ")}
   - ถ้าฉลากไม่พูดถึงเรื่องนี้เลย ให้ใส่ "" (ว่าง) แม้จะเดาได้จากชื่อสินค้าก็ตาม

รายละเอียดแต่ละช่อง:
- nameTh = ชื่อวัตถุดิบตามที่พิมพ์บนฉลาก (คงภาษาเดิม ไม่ต้องแปล)
- type = ประเภท เลือกจากรายการนี้เท่านั้น: ${RM_TYPES.join(" / ")} (ถ้าไม่แน่ใจใส่ "")
- supplier = ชื่อบริษัทผู้ผลิต/ผู้จำหน่ายบนฉลาก
- lot = เลข Lot / Batch / LOT No.
- qty = ตัวเลขน้ำหนักหรือปริมาณสุทธิ (ใส่เฉพาะตัวเลข เช่น "100")
- unit = หน่วย เลือกจาก: ${UNITS.join(" / ")} (g/กรัม→"กรัม", kg→"กก.", ml→"มล.")
- mfg = วันผลิต รูปแบบ YYYY-MM-DD ถ้าแปลงได้ ถ้าไม่ได้ใส่ข้อความตามฉลาก
- exp = วันหมดอายุ/BBF/Best Before รูปแบบเดียวกับ mfg
- productCode = รหัสสินค้า/Product code/Ref code บนฉลาก
- note = ข้อมูลอื่นบนฉลากที่มีประโยชน์ต่อ R&D เช่น ฮาลาล โคเชอร์ วีแกน Non-GMO วิธีเก็บรักษา คำเตือน (สรุปสั้น ๆ ภาษาไทย)
- confidence = ความมั่นใจในการอ่านโดยรวม ตอบว่า "สูง" หรือ "กลาง" หรือ "ต่ำ" (ถ้ารูปเบลอ/เอียง/แสงไม่พอ ให้ตอบ "ต่ำ")`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    nameTh: { type: "STRING" },
    type: { type: "STRING" },
    supplier: { type: "STRING" },
    lot: { type: "STRING" },
    qty: { type: "STRING" },
    unit: { type: "STRING" },
    allergen: { type: "STRING" },
    mfg: { type: "STRING" },
    exp: { type: "STRING" },
    productCode: { type: "STRING" },
    note: { type: "STRING" },
    confidence: { type: "STRING" },
  },
  required: ["nameTh", "confidence"],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "ใช้ได้เฉพาะ POST" }, 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Supabase (Edge Functions > Secrets)" }, 500);

  let image = "", mime = "image/jpeg";
  try {
    const body = await req.json();
    image = body.image || "";
    mime = body.mime || "image/jpeg";
  } catch {
    return json({ error: "อ่าน body ไม่ได้" }, 400);
  }
  if (!image) return json({ error: "ไม่พบรูปภาพ" }, 400);

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" + key;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mime, data: image } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      }),
    });
  } catch (e) {
    return json({ error: "เรียก Gemini ไม่สำเร็จ: " + String(e) }, 502);
  }

  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 400);
    if (res.status === 429) msg = "โควตาฟรีของวันนี้เต็มแล้ว ลองใหม่พรุ่งนี้ หรือกรอกเอง";
    if (res.status === 400 && raw.includes("API key")) msg = "API key ไม่ถูกต้อง — ตรวจค่า GEMINI_API_KEY";
    return json({ error: "Gemini ตอบกลับผิดพลาด (" + res.status + "): " + msg }, 502);
  }

  try {
    const data = JSON.parse(raw);
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) return json({ error: "Gemini ไม่ได้ส่งข้อมูลกลับมา (อาจอ่านรูปไม่ออก)" }, 502);
    const out = JSON.parse(txt);
    if (out.type && !RM_TYPES.includes(out.type)) out.type = "";
    if (out.allergen && !ALLERGENS.includes(out.allergen)) out.allergen = "";
    if (out.unit && !UNITS.includes(out.unit)) out.unit = "";
    return json(out);
  } catch (e) {
    return json({ error: "แปลงผลลัพธ์ไม่สำเร็จ: " + String(e) }, 502);
  }
});
