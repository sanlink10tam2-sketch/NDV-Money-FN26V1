import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PayOS } from "@payos/node";
import rateLimit from "express-rate-limit";

// Load environment variables as early as possible
dotenv.config();
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");

const loadConfig = () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch (e) {
    console.error("[CONFIG] Failed to load config.json:", e);
  }
  return {};
};

const saveConfig = (newConfig: any) => {
  try {
    const currentConfig = loadConfig();
    const updatedConfig = { ...currentConfig, ...newConfig };

    // Parse numeric fields if they are present and not empty
    const numericFields = ['PRE_DISBURSEMENT_FEE', 'MAX_EXTENSIONS', 'UPGRADE_PERCENT', 'FINE_RATE', 'MAX_FINE_PERCENT', 'MAX_LOAN_PER_CYCLE', 'MIN_SYSTEM_BUDGET', 'MAX_SINGLE_LOAN_AMOUNT'];
    numericFields.forEach(field => {
      if (updatedConfig[field] !== undefined && updatedConfig[field] !== '') {
        const val = Number(updatedConfig[field]);
        if (!isNaN(val)) {
          updatedConfig[field] = val;
        }
      }
    });

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updatedConfig, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[CONFIG] Failed to save config.json:", e);
    return false;
  }
};

const config = loadConfig();

let SUPABASE_URL = config.SUPABASE_URL || process.env.SUPABASE_URL || "";
let SUPABASE_KEY = config.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

const isValidUrl = (url: string) => {
  if (!url) return false;
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
};

const isPlaceholder = (val: string) => 
  !val || val.includes("your-project-id") || val.includes("your-service-role-key") || val === "https://your-project-id.supabase.co";

const getBusinessOp = (settings: any, key: string) => {
  if (!settings) return null;
  return settings.BUSINESS_OPERATIONS_CONFIG?.find((op: any) => op.key === key);
};

// In-memory cache for settings to reduce DB load
let settingsCache: any = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 15 * 60 * 1000; // Increased to 15 minutes for better performance

// Helper to load system settings from Supabase
const loadSystemSettings = async (client: any) => {
  try {
    if (!client) return {};
    
    // Check cache first
    const now = Date.now();
    if (settingsCache && (now - lastCacheUpdate < CACHE_TTL)) {
      return settingsCache;
    }

    const { data, error } = await client.from('config').select('key, value');
    if (error) throw error;
    
    const settings: any = {};
    data.forEach((item: any) => {
      // Only include system settings keys
      const systemKeys = [
        'PAYMENT_ACCOUNT', 'PRE_DISBURSEMENT_FEE', 'MAX_EXTENSIONS', 
        'UPGRADE_PERCENT', 'FINE_RATE', 'MAX_FINE_PERCENT', 
        'MAX_LOAN_PER_CYCLE', 'MIN_SYSTEM_BUDGET', 'MAX_SINGLE_LOAN_AMOUNT', 'INITIAL_LIMIT',
        'IMGBB_API_KEY', 'PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY',
        'APP_URL', 'JWT_SECRET', 'ADMIN_PHONE', 'ADMIN_PASSWORD',
        'CONTRACT_CODE_FORMAT', 'USER_ID_FORMAT', 'ZALO_GROUP_LINK',
        'SYSTEM_NOTIFICATION', 'SHOW_SYSTEM_NOTIFICATION',
        'SYSTEM_BUDGET', 'TOTAL_LOAN_PROFIT', 'TOTAL_RANK_PROFIT', 'MONTHLY_STATS',
        'ENABLE_PAYOS', 'ENABLE_VIETQR', 'LUCKY_SPIN_VOUCHERS', 'LUCKY_SPIN_WIN_RATE',
        'LUCKY_SPIN_PAYMENTS_REQUIRED', 'MAX_ON_TIME_PAYMENTS_FOR_UPGRADE', 'CONTRACT_CLAUSES',
        'RANK_CONFIG', 'SYSTEM_FORMATS_CONFIG', 'BUSINESS_OPERATIONS_CONFIG', 
        'CONTRACT_FORMATS_CONFIG', 'TRANSFER_CONTENTS_CONFIG', 'SYSTEM_CONTRACT_FORMATS_CONFIG', 'MASTER_CONFIGS', 'lastKeepAlive'
      ];
      if (systemKeys.includes(item.key)) {
        if (['MONTHLY_STATS', 'PAYMENT_ACCOUNT', 'LUCKY_SPIN_VOUCHERS', 'RANK_CONFIG', 'SYSTEM_FORMATS_CONFIG', 'BUSINESS_OPERATIONS_CONFIG', 'CONTRACT_FORMATS_CONFIG', 'TRANSFER_CONTENTS_CONFIG', 'SYSTEM_CONTRACT_FORMATS_CONFIG', 'MASTER_CONFIGS', 'CONTRACT_CLAUSES'].includes(item.key)) {
          try {
            settings[item.key] = typeof item.value === 'string' ? JSON.parse(item.value) : item.value;
          } catch (e) {
            settings[item.key] = item.value;
          }
        } else if (['SYSTEM_BUDGET', 'TOTAL_LOAN_PROFIT', 'TOTAL_RANK_PROFIT', 'UPGRADE_PERCENT', 'PRE_DISBURSEMENT_FEE', 'MAX_EXTENSIONS', 'FINE_RATE', 'MAX_FINE_PERCENT', 'MAX_LOAN_PER_CYCLE', 'MIN_SYSTEM_BUDGET', 'MAX_SINGLE_LOAN_AMOUNT', 'INITIAL_LIMIT', 'LUCKY_SPIN_WIN_RATE', 'LUCKY_SPIN_PAYMENTS_REQUIRED', 'MAX_ON_TIME_PAYMENTS_FOR_UPGRADE'].includes(item.key)) {
          settings[item.key] = Number(item.value);
        } else if (['ENABLE_PAYOS', 'ENABLE_VIETQR', 'SHOW_SYSTEM_NOTIFICATION'].includes(item.key)) {
          settings[item.key] = item.value === true || item.value === 'true';
        } else {
          settings[item.key] = item.value;
        }
      }
    });

    settingsCache = settings;
    lastCacheUpdate = now;
    return settings;
  } catch (e) {
    console.error("[CONFIG] Failed to load settings from Supabase:", e);
    return settingsCache || {}; // Return stale cache if DB fails
  }
};

// Helper to get merged settings
const getMergedSettings = async (client: any) => {
  const config = loadConfig();
  const dbSettings = await loadSystemSettings(client);
  
  return {
    SUPABASE_URL: config.SUPABASE_URL || process.env.SUPABASE_URL || "",
    SUPABASE_SERVICE_ROLE_KEY: config.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "",
    IMGBB_API_KEY: dbSettings.IMGBB_API_KEY || config.IMGBB_API_KEY || process.env.VITE_IMGBB_API_KEY || "",
    PAYMENT_ACCOUNT: dbSettings.PAYMENT_ACCOUNT || config.PAYMENT_ACCOUNT || { bankName: "", bankBin: "", accountNumber: "", accountName: "" },
    PRE_DISBURSEMENT_FEE: Number(dbSettings.PRE_DISBURSEMENT_FEE !== undefined ? dbSettings.PRE_DISBURSEMENT_FEE : (config.PRE_DISBURSEMENT_FEE !== undefined ? config.PRE_DISBURSEMENT_FEE : 10)),
    MAX_EXTENSIONS: Number(dbSettings.MAX_EXTENSIONS !== undefined ? dbSettings.MAX_EXTENSIONS : (config.MAX_EXTENSIONS !== undefined ? config.MAX_EXTENSIONS : 3)),
    UPGRADE_PERCENT: Number(dbSettings.UPGRADE_PERCENT !== undefined ? dbSettings.UPGRADE_PERCENT : (config.UPGRADE_PERCENT !== undefined ? config.UPGRADE_PERCENT : 10)),
    FINE_RATE: Number(dbSettings.FINE_RATE !== undefined ? dbSettings.FINE_RATE : (config.FINE_RATE !== undefined ? config.FINE_RATE : 2)),
    MAX_FINE_PERCENT: Number(dbSettings.MAX_FINE_PERCENT !== undefined ? dbSettings.MAX_FINE_PERCENT : (config.MAX_FINE_PERCENT !== undefined ? config.MAX_FINE_PERCENT : 30)),
    MAX_LOAN_PER_CYCLE: Number(dbSettings.MAX_LOAN_PER_CYCLE !== undefined ? dbSettings.MAX_LOAN_PER_CYCLE : (config.MAX_LOAN_PER_CYCLE !== undefined ? config.MAX_LOAN_PER_CYCLE : 10000000)),
    MIN_SYSTEM_BUDGET: Number(dbSettings.MIN_SYSTEM_BUDGET !== undefined ? dbSettings.MIN_SYSTEM_BUDGET : (config.MIN_SYSTEM_BUDGET !== undefined ? config.MIN_SYSTEM_BUDGET : 1000000)),
    MAX_SINGLE_LOAN_AMOUNT: Number(dbSettings.MAX_SINGLE_LOAN_AMOUNT !== undefined ? dbSettings.MAX_SINGLE_LOAN_AMOUNT : (config.MAX_SINGLE_LOAN_AMOUNT !== undefined ? config.MAX_SINGLE_LOAN_AMOUNT : 10000000)),
    PAYOS_CLIENT_ID: dbSettings.PAYOS_CLIENT_ID || config.PAYOS_CLIENT_ID || process.env.PAYOS_CLIENT_ID || "",
    PAYOS_API_KEY: dbSettings.PAYOS_API_KEY || config.PAYOS_API_KEY || process.env.PAYOS_API_KEY || "",
    PAYOS_CHECKSUM_KEY: dbSettings.PAYOS_CHECKSUM_KEY || config.PAYOS_CHECKSUM_KEY || process.env.PAYOS_CHECKSUM_KEY || "",
    APP_URL: dbSettings.APP_URL || config.APP_URL || process.env.APP_URL || "",
    JWT_SECRET: dbSettings.JWT_SECRET || config.JWT_SECRET || process.env.JWT_SECRET || "ndv-money-secret-key-2026",
    ADMIN_PHONE: dbSettings.ADMIN_PHONE || config.ADMIN_PHONE || process.env.ADMIN_PHONE || '0877203996',
    ADMIN_PASSWORD: dbSettings.ADMIN_PASSWORD || config.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '119011Ngon',
    CONTRACT_CODE_FORMAT: dbSettings.CONTRACT_CODE_FORMAT || config.CONTRACT_CODE_FORMAT || "HD-{MHD}",
    USER_ID_FORMAT: dbSettings.USER_ID_FORMAT || config.USER_ID_FORMAT || "US-{RANDOM}",
    ZALO_GROUP_LINK: dbSettings.ZALO_GROUP_LINK || config.ZALO_GROUP_LINK || "",
    SYSTEM_NOTIFICATION: dbSettings.SYSTEM_NOTIFICATION || config.SYSTEM_NOTIFICATION || "",
    SHOW_SYSTEM_NOTIFICATION: dbSettings.SHOW_SYSTEM_NOTIFICATION !== undefined ? dbSettings.SHOW_SYSTEM_NOTIFICATION : (config.SHOW_SYSTEM_NOTIFICATION !== undefined ? config.SHOW_SYSTEM_NOTIFICATION : false),
    ENABLE_PAYOS: dbSettings.ENABLE_PAYOS !== undefined ? dbSettings.ENABLE_PAYOS : (config.ENABLE_PAYOS !== undefined ? config.ENABLE_PAYOS : true),
    ENABLE_VIETQR: dbSettings.ENABLE_VIETQR !== undefined ? dbSettings.ENABLE_VIETQR : (config.ENABLE_VIETQR !== undefined ? config.ENABLE_VIETQR : true),
    SYSTEM_BUDGET: dbSettings.SYSTEM_BUDGET !== undefined ? dbSettings.SYSTEM_BUDGET : 0,
    TOTAL_LOAN_PROFIT: dbSettings.TOTAL_LOAN_PROFIT !== undefined ? dbSettings.TOTAL_LOAN_PROFIT : 0,
    TOTAL_RANK_PROFIT: dbSettings.TOTAL_RANK_PROFIT !== undefined ? dbSettings.TOTAL_RANK_PROFIT : 0,
    MONTHLY_STATS: dbSettings.MONTHLY_STATS || [],
    LUCKY_SPIN_VOUCHERS: dbSettings.LUCKY_SPIN_VOUCHERS || config.LUCKY_SPIN_VOUCHERS || [
      { minProfit: 1000000, voucherValue: 50000 },
      { minProfit: 2000000, voucherValue: 100000 },
      { minProfit: 5000000, voucherValue: 200000 }
    ],
    LUCKY_SPIN_WIN_RATE: dbSettings.LUCKY_SPIN_WIN_RATE !== undefined ? dbSettings.LUCKY_SPIN_WIN_RATE : (config.LUCKY_SPIN_WIN_RATE !== undefined ? config.LUCKY_SPIN_WIN_RATE : 30),
    LUCKY_SPIN_PAYMENTS_REQUIRED: dbSettings.LUCKY_SPIN_PAYMENTS_REQUIRED !== undefined ? dbSettings.LUCKY_SPIN_PAYMENTS_REQUIRED : (config.LUCKY_SPIN_PAYMENTS_REQUIRED !== undefined ? config.LUCKY_SPIN_PAYMENTS_REQUIRED : 3),
    MAX_ON_TIME_PAYMENTS_FOR_UPGRADE: dbSettings.MAX_ON_TIME_PAYMENTS_FOR_UPGRADE !== undefined ? dbSettings.MAX_ON_TIME_PAYMENTS_FOR_UPGRADE : (config.MAX_ON_TIME_PAYMENTS_FOR_UPGRADE !== undefined ? config.MAX_ON_TIME_PAYMENTS_FOR_UPGRADE : 5),
    CONTRACT_CLAUSES: dbSettings.CONTRACT_CLAUSES || config.CONTRACT_CLAUSES || null,
    RANK_CONFIG: dbSettings.RANK_CONFIG || config.RANK_CONFIG || [
      { id: 'standard', name: 'TIÊU CHUẨN', minLimit: 1000000, maxLimit: 2000000, color: '#6b7280', features: ['Hạn mức 1 - 2 triệu', 'Duyệt trong 24h'] },
      { id: 'bronze', name: 'ĐỒNG', minLimit: 1000000, maxLimit: 3000000, color: '#fdba74', features: ['Hạn mức 1 - 3 triệu', 'Ưu tiên duyệt lệnh'] },
      { id: 'silver', name: 'BẠC', minLimit: 1000000, maxLimit: 4000000, color: '#bfdbfe', features: ['Hạn mức 1 - 4 triệu', 'Hỗ trợ 24/7'] },
      { id: 'gold', name: 'VÀNG', minLimit: 1000000, maxLimit: 5000000, color: '#facc15', features: ['Hạn mức 1 - 5 triệu', 'Giảm 10% phí phạt'] },
      { id: 'diamond', name: 'KIM CƯƠNG', minLimit: 1000000, maxLimit: 10000000, color: '#60a5fa', features: ['Hạn mức 1 - 10 triệu', 'Duyệt lệnh tức thì'] }
    ],
    SYSTEM_FORMATS_CONFIG: dbSettings.SYSTEM_FORMATS_CONFIG || config.SYSTEM_FORMATS_CONFIG || [
      { key: 'CONTRACT_CODE_FORMAT', label: 'Định dạng Mã Hợp Đồng', value: "HD-{MHD}", description: 'Dùng {ID}, {VT}, {N}' },
      { key: 'USER_ID_FORMAT', label: 'Định dạng ID User', value: "US-{RANDOM}", description: 'Dùng {RANDOM}, {N}' }
    ],
    BUSINESS_OPERATIONS_CONFIG: dbSettings.BUSINESS_OPERATIONS_CONFIG || config.BUSINESS_OPERATIONS_CONFIG || [
      { 
        key: 'FULL_SETTLEMENT', 
        label: 'Tất toán', 
        abbr: 'TT', 
        original: 'Tất toán',
        type: 'text',
        hasContent: true, 
        hasFormat: false,
        contentKey: 'PAYMENT_CONTENT_FULL_SETTLEMENT',
        placeholders: '{ID}, {MHD}, {USER}'
      },
      { 
        key: 'PARTIAL_SETTLEMENT', 
        label: 'Tất toán 1 phần', 
        abbr: 'TTMP', 
        original: 'Tất toán một phần',
        type: 'text',
        hasContent: true, 
        hasFormat: true,
        contentKey: 'PAYMENT_CONTENT_PARTIAL_SETTLEMENT',
        formatKey: 'CONTRACT_FORMAT_PARTIAL_SETTLEMENT',
        placeholders: '{ID}, {MHD}, {SLTTMP}, {USER}'
      },
      { 
        key: 'EXTENSION', 
        label: 'Gia hạn', 
        abbr: 'GH', 
        original: 'Gia hạn',
        type: 'text',
        hasContent: true, 
        hasFormat: true,
        contentKey: 'PAYMENT_CONTENT_EXTENSION',
        formatKey: 'CONTRACT_FORMAT_EXTENSION',
        placeholders: '{ID}, {MHD}, {SLGH}, {USER}'
      },
      { 
        key: 'UPGRADE', 
        label: 'Nâng hạng', 
        abbr: 'NH', 
        original: 'Nâng hạng',
        type: 'text',
        hasContent: true, 
        hasFormat: false,
        contentKey: 'PAYMENT_CONTENT_UPGRADE',
        placeholders: '{TEN HANG}, {USER}'
      },
      { 
        key: 'DISBURSE', 
        label: 'Giải ngân', 
        abbr: 'GN', 
        original: 'Giải ngân',
        type: 'text',
        hasContent: false, 
        hasFormat: false 
      }
    ],
    CONTRACT_FORMATS_CONFIG: dbSettings.CONTRACT_FORMATS_CONFIG || config.CONTRACT_FORMATS_CONFIG || [],
    TRANSFER_CONTENTS_CONFIG: dbSettings.TRANSFER_CONTENTS_CONFIG || config.TRANSFER_CONTENTS_CONFIG || [
      { key: 'FULL_SETTLEMENT', original: 'Tất toán', abbr: 'TT', value: 'TAT TOAN {ID}' },
      { key: 'PARTIAL_SETTLEMENT', original: 'TT 1 phần', abbr: 'TTMP', value: 'TTMP {ID} LAN {SLTTMP}' },
      { key: 'EXTENSION', original: 'Gia hạn', abbr: 'GH', value: 'GIA HAN {ID} LAN {SLGH}' },
      { key: 'UPGRADE', original: 'Nâng hạng', abbr: 'NH', value: 'HANG {RANK} {USER}' }
    ],
    SYSTEM_CONTRACT_FORMATS_CONFIG: dbSettings.SYSTEM_CONTRACT_FORMATS_CONFIG || config.SYSTEM_CONTRACT_FORMATS_CONFIG || [
      { key: 'PARTIAL_SETTLEMENT', original: 'TT 1 phần', abbr: 'TTMP', value: '{ID}TTMP{N}' },
      { key: 'EXTENSION', original: 'Gia hạn', abbr: 'GH', value: '{ID}GH{N}' }
    ],
    MASTER_CONFIGS: dbSettings.MASTER_CONFIGS || config.MASTER_CONFIGS || []
  };
};


// Helper to get PayOS instance
const getPayOS = (settings: any) => {
  return new PayOS({
    clientId: settings.PAYOS_CLIENT_ID || "",
    apiKey: settings.PAYOS_API_KEY || "",
    checksumKey: settings.PAYOS_CHECKSUM_KEY || ""
  });
};

// Helper to save system settings to Supabase
const saveSystemSettings = async (client: any, newSettings: any) => {
  try {
    if (!client) return false;
    
    const upserts = Object.entries(newSettings).map(([key, value]) => ({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value)
    }));
    
    if (upserts.length === 0) return true;
    
    const { error } = await client.from('config').upsert(upserts, { onConflict: 'key' });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("[CONFIG] Failed to save settings to Supabase:", e);
    return false;
  }
};

const app = express();
const router = express.Router();

// Migration to Unified Master Config
router.post("/migrate-unified-config", async (req: any, res) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện migration" });
  }

  const client = initSupabase();
  const settings = await getMergedSettings(client);
  
  if (Array.isArray(settings.MASTER_CONFIGS) && settings.MASTER_CONFIGS.length > 0) {
    return res.json({ message: "Hệ thống đã có cấu hình hợp nhất. Không cần migration." });
  }

  const masterConfigs: any[] = [];

  // 1. Abbreviations
  if (Array.isArray(settings.BUSINESS_OPERATIONS_CONFIG)) {
    settings.BUSINESS_OPERATIONS_CONFIG.forEach((op: any) => {
      masterConfigs.push({
        id: `abbr_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        category: 'ABBREVIATION',
        originalName: op.original || op.label || '',
        abbreviation: op.abbr || '',
        format: '',
        systemMeaning: op.type || op.key || ''
      });
    });
  }

  // 2. ID Formats
  if (Array.isArray(settings.SYSTEM_FORMATS_CONFIG)) {
    settings.SYSTEM_FORMATS_CONFIG.forEach((f: any) => {
      masterConfigs.push({
        id: `id_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        category: 'ID_FORMAT',
        originalName: f.label || '',
        abbreviation: '',
        format: f.value || '',
        systemMeaning: f.type || f.key || ''
      });
    });
  }

  // 3. New Contract Formats
  if (Array.isArray(settings.SYSTEM_CONTRACT_FORMATS_CONFIG)) {
    settings.SYSTEM_CONTRACT_FORMATS_CONFIG.forEach((f: any) => {
      masterConfigs.push({
        id: `contract_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        category: 'CONTRACT_NEW',
        originalName: f.label || f.original || '',
        abbreviation: f.abbr || '',
        format: f.value || '',
        systemMeaning: f.type || f.key || ''
      });
    });
  }

  // 4. Transfer Content
  if (Array.isArray(settings.TRANSFER_CONTENTS_CONFIG)) {
    settings.TRANSFER_CONTENTS_CONFIG.forEach((f: any) => {
      masterConfigs.push({
        id: `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        category: 'TRANSFER_CONTENT',
        originalName: f.original || f.label || '',
        abbreviation: f.abbr || '',
        format: f.value || '',
        systemMeaning: f.key || ''
      });
    });
  }

  if (masterConfigs.length === 0) {
    return res.json({ message: "Không tìm thấy cấu hình cũ để migration." });
  }

  const saved = await saveSystemSettings(client, { MASTER_CONFIGS: masterConfigs });
  
  if (saved) {
    settingsCache = null;
    lastCacheUpdate = 0;
    res.json({ success: true, message: "Migration sang cấu hình hợp nhất thành công!", count: masterConfigs.length });
  } else {
    res.status(500).json({ error: "Lỗi khi lưu cấu hình hợp nhất vào Database" });
  }
});
let supabase: any = null;

// Rate limiting for API security
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu từ IP này, vui lòng thử lại sau 15 phút." }
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 login/register attempts per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều lần thử đăng nhập, vui lòng thử lại sau 1 giờ." }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use("/api", apiLimiter);
app.use("/api/login", authLimiter);
app.use("/api/register", authLimiter);

// Mount router at both root and /api to handle both local and Vercel environments
// When used as a sub-app in server.ts, it will be mounted at /api, 
// so requests to /api/data will reach here as /data.
app.use("/api", router);
app.use("/", router);

// Helper to safely stringify data that might contain BigInt
const safeJsonStringify = (data: any) => {
  return JSON.stringify(data, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
};

// Helper to send JSON response safely
const sendSafeJson = (res: express.Response, data: any, status = 200) => {
  try {
    const json = safeJsonStringify(data);
    res.status(status).set('Content-Type', 'application/json').send(json);
  } catch (e: any) {
    console.error("[API ERROR] Failed to serialize JSON:", e);
    res.status(500).json({
      error: "Lỗi serialization",
      message: "Không thể chuyển đổi dữ liệu sang JSON: " + e.message
    });
  }
};

// Safe initialization function
const initSupabase = (force = false) => {
  if (supabase && !force) return supabase;

  const config = loadConfig();
  const url = config.SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = config.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

  console.log(`[API] Attempting to initialize Supabase. URL present: ${!!url}, Key present: ${!!key}`);

  if (url && key && isValidUrl(url) && !isPlaceholder(url) && !isPlaceholder(key)) {
    try {
      supabase = createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      });
      console.log("[API] Supabase client initialized successfully.");
      return supabase;
    } catch (e) {
      console.error("[API] Supabase init error:", e);
      return null;
    }
  }
  console.warn("[API] Supabase credentials missing or invalid.");
  return null;
};

// Initialize once at module level
initSupabase();

const STORAGE_LIMIT_MB = 45; // Virtual limit for demo purposes

// Debug middleware to log incoming requests
router.use((req, res, next) => {
  console.log(`[API DEBUG] ${req.method} ${req.url}`);
  next();
});

// Middleware to check Supabase configuration
router.use((req, res, next) => {
  // Allow health checks without Supabase
  // In Express v5, req.path is relative to the mount point.
  // We check for both relative and absolute paths to be safe.
  const isHealthRoute = 
    req.path === '/api-health' || 
    req.path === '/supabase-status' || 
    req.path === '/public-settings' ||
    req.originalUrl === '/api/api-health' || 
    req.originalUrl === '/api/supabase-status' ||
    req.originalUrl === '/api/public-settings';

  if (isHealthRoute) return next();
  
  const client = initSupabase();

  if (!client) {
    return res.status(500).json({
      error: "Cấu hình Supabase không hợp lệ",
      message: "Hệ thống chưa được cấu hình Supabase URL hoặc Service Role Key trên Vercel. Vui lòng kiểm tra Settings -> Environment Variables."
    });
  }
  next();
});

// Helper to check if a route is public
const isPublicRoute = (reqPath: string) => {
  if (!reqPath) return false;
  const path = reqPath.replace(/\/$/, '');
  const publicRoutes = [
    '/login', '/register', '/api-health', '/supabase-status', 
    '/keep-alive', '/payment/webhook', '/payment-result', '/public-settings'
  ];
  return publicRoutes.includes(path) || 
         publicRoutes.some(route => path === '/api' + route) ||
         path.startsWith('/api/public');
};

// Authentication Middleware
const authenticateToken = async (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    if (isPublicRoute(req.path) || isPublicRoute(req.originalUrl || '')) {
      return next();
    }
    return res.status(401).json({ error: "Yêu cầu xác thực" });
  }

  try {
    const client = initSupabase();
    const settings = await getMergedSettings(client);
    
    const user = jwt.verify(token, settings.JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Token không hợp lệ hoặc đã hết hạn" });
  }
};

// Apply auth middleware to all routes except login/register/health/webhook
router.use((req, res, next) => {
  if (isPublicRoute(req.path) || isPublicRoute(req.originalUrl || '')) {
    return next();
  }
  authenticateToken(req, res, next);
});

// Helper to estimate JSON size in MB
const getStorageUsage = (data: any) => {
  try {
    const str = safeJsonStringify(data);
    return (Buffer.byteLength(str, 'utf8') / (1024 * 1024));
  } catch (e) {
    console.error("Error calculating storage usage:", e);
    return 0;
  }
};

let isCleaningUp = false;

// Auto-cleanup task: Delete old notifications and loans efficiently
const autoCleanupStorage = async () => {
  const client = initSupabase();
  if (!client || isCleaningUp) return;
  
  isCleaningUp = true;
  try {
    console.log("[Cleanup] Starting storage cleanup...");
    const now = new Date();
    
    // 1. Cleanup Notifications: Delete all but the 10 most recent per user
    const { data: allNotifs, error: fetchError } = await client.from('notifications')
      .select('id, userId')
      .order('id', { ascending: false });
    
    if (fetchError) throw fetchError;

    if (allNotifs && allNotifs.length > 0) {
      const userNotifCounts: Record<string, number> = {};
      const idsToDelete: string[] = [];
      
      for (const notif of allNotifs) {
        userNotifCounts[notif.userId] = (userNotifCounts[notif.userId] || 0) + 1;
        if (userNotifCounts[notif.userId] > 3) {
          idsToDelete.push(notif.id);
        }
      }
      
      if (idsToDelete.length > 0) {
        for (let i = 0; i < idsToDelete.length; i += 100) {
          const chunk = idsToDelete.slice(i, i + 100);
          await client.from('notifications').delete().in('id', chunk);
        }
        console.log(`[Cleanup] Deleted ${idsToDelete.length} old notifications`);
      }
    }

    // 2. Cleanup Loans: Delete Rejected and Settled (>30d)
    // This mechanism keeps the database clean by removing old history
    // Rejected loans are deleted after 30 days
    // Settled loans are deleted after 30 days to save storage space
    const thirtyDaysAgo = now.getTime() - (30 * 24 * 60 * 60 * 1000);

    const { error: err1 } = await client.from('loans')
      .delete()
      .eq('status', 'BỊ TỪ CHỐI')
      .lt('updatedAt', thirtyDaysAgo);
    
    const { error: err2 } = await client.from('loans')
      .delete()
      .eq('status', 'ĐÃ TẤT TOÁN')
      .lt('updatedAt', thirtyDaysAgo);

    if (err1 || err2) console.error("[Cleanup] Error deleting old loans:", JSON.stringify(err1 || err2));

    // 3. Cleanup Budget Logs: Delete entries older than 60 days
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const sixtyDaysAgoStr = sixtyDaysAgo.toISOString();

    const { error: err3 } = await client.from('budget_logs')
      .delete()
      .lt('createdAt', sixtyDaysAgoStr);
    
    if (err3) console.error("[Cleanup] Error deleting old budget logs:", JSON.stringify(err3));
    
    console.log("[Cleanup] Storage cleanup completed.");
  } catch (e) {
    console.error("Lỗi auto-cleanup:", e);
  } finally {
    isCleaningUp = false;
  }
};

// Keep-Alive function to prevent Supabase from pausing
export const keepAliveSupabase = async () => {
  const client = initSupabase();
  if (!client) return;
  try {
    console.log("[Keep-Alive] Pinging Supabase to prevent project pausing...");
    // Perform a simple query to keep the project active
    const { error } = await client.from('users').select('id').limit(1);
    if (error) throw error;
    
    // Save the last success timestamp in the config table
    await client.from('config').upsert({ key: 'lastKeepAlive', value: new Date().toISOString() }, { onConflict: 'key' });
    
    // Invalidate cache to ensure next data fetch gets the new timestamp
    settingsCache = null;
    lastCacheUpdate = 0;
    
    console.log("[Keep-Alive] Supabase ping successful.");
    return true;
  } catch (e: any) {
    console.error("[Keep-Alive] Supabase ping failed:", e.message || e);
    return false;
  }
};

// Supabase Status check for Admin
router.get("/supabase-status", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) {
      return res.json({ 
        connected: false, 
        error: "Chưa cấu hình Supabase hoặc URL không hợp lệ. Vui lòng kiểm tra biến môi trường." 
      });
    }
    
    // Trigger keepAlive logic to update timestamp and clear cache
    const keepAliveSuccess = await keepAliveSupabase();
    
    // Use a more standard count query
    const { error } = await client.from('users').select('*', { count: 'exact', head: true });
    
    if (error) {
      console.error("Supabase connection error details:", JSON.stringify(error));
      return res.json({ 
        connected: false, 
        error: `Lỗi kết nối Supabase: ${error.message} (${error.code})` 
      });
    }
    
    res.json({ 
      connected: true, 
      message: "Kết nối Supabase ổn định",
      keepAlive: keepAliveSuccess ? "Updated" : "Failed"
    });
  } catch (e: any) {
    console.error("Critical error in /supabase-status:", e);
    res.json({ connected: false, error: `Lỗi hệ thống: ${e.message}` });
  }
});

// Keep-Alive endpoint for external services
router.get("/keep-alive", async (req, res) => {
  console.log(`[KEEP-ALIVE] Received ping at ${new Date().toISOString()} from ${req.ip}`);
  const success = await keepAliveSupabase();
  if (success) {
    const timestamp = new Date().toISOString();
    const io = req.app.get("io");
    if (io) {
      console.log(`[KEEP-ALIVE] Emitting supabase_ping to admin room`);
      io.to("admin").emit("supabase_ping", { timestamp });
    }
    res.json({ status: "ok", message: "Supabase keep-alive successful", timestamp });
  } else {
    console.error(`[KEEP-ALIVE] Supabase keep-alive failed`);
    res.status(500).json({ status: "error", message: "Supabase keep-alive failed" });
  }
});

// API Routes
router.get("/public-settings", async (req, res) => {
  const client = initSupabase();
  const merged = await getMergedSettings(client);
  
  // Return only non-sensitive settings
  const publicSettings = {
    IMGBB_API_KEY: merged.IMGBB_API_KEY,
    PAYMENT_ACCOUNT: merged.PAYMENT_ACCOUNT,
    PRE_DISBURSEMENT_FEE: merged.PRE_DISBURSEMENT_FEE,
    MAX_EXTENSIONS: merged.MAX_EXTENSIONS,
    UPGRADE_PERCENT: merged.UPGRADE_PERCENT,
    FINE_RATE: merged.FINE_RATE,
    MAX_FINE_PERCENT: merged.MAX_FINE_PERCENT,
    MAX_LOAN_PER_CYCLE: merged.MAX_LOAN_PER_CYCLE,
    MIN_SYSTEM_BUDGET: merged.MIN_SYSTEM_BUDGET,
    MAX_SINGLE_LOAN_AMOUNT: merged.MAX_SINGLE_LOAN_AMOUNT,
    APP_URL: merged.APP_URL,
    CONTRACT_CODE_FORMAT: merged.CONTRACT_CODE_FORMAT,
    USER_ID_FORMAT: merged.USER_ID_FORMAT,
    ZALO_GROUP_LINK: merged.ZALO_GROUP_LINK,
    SYSTEM_NOTIFICATION: merged.SYSTEM_NOTIFICATION,
    ENABLE_PAYOS: merged.ENABLE_PAYOS,
    ENABLE_VIETQR: merged.ENABLE_VIETQR,
    SYSTEM_FORMATS_CONFIG: merged.SYSTEM_FORMATS_CONFIG,
    BUSINESS_OPERATIONS_CONFIG: merged.BUSINESS_OPERATIONS_CONFIG,
    CONTRACT_FORMATS_CONFIG: merged.CONTRACT_FORMATS_CONFIG,
    TRANSFER_CONTENTS_CONFIG: merged.TRANSFER_CONTENTS_CONFIG,
    SYSTEM_CONTRACT_FORMATS_CONFIG: merged.SYSTEM_CONTRACT_FORMATS_CONFIG,
    MASTER_CONFIGS: merged.MASTER_CONFIGS
  };
  
  res.json(publicSettings);
});

router.get("/settings", async (req, res) => {
  const client = initSupabase();
  const merged = await getMergedSettings(client);
  res.json(merged);
});

router.post("/settings", async (req: any, res) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Chỉ Admin mới có quyền thay đổi cài đặt" });
  }

  const newConfig = req.body;
  
  // Validation: Ensure at least one payment method is enabled
  // We check if both are explicitly set to false in the request
  if (newConfig.ENABLE_PAYOS === false && newConfig.ENABLE_VIETQR === false) {
    return res.status(400).json({ error: "Phải có ít nhất một phương thức thanh toán được bật." });
  }

  const client = initSupabase();
  
  // 1. Save credentials to file (still needed for initial boot)
  const fileConfig: any = {};
  if (newConfig.SUPABASE_URL) fileConfig.SUPABASE_URL = newConfig.SUPABASE_URL;
  if (newConfig.SUPABASE_SERVICE_ROLE_KEY) fileConfig.SUPABASE_SERVICE_ROLE_KEY = newConfig.SUPABASE_SERVICE_ROLE_KEY;
  
  if (Object.keys(fileConfig).length > 0) {
    saveConfig(fileConfig);
    initSupabase(true); // Re-init if credentials changed
  }
  
  // 2. Save system settings to Supabase for persistence
  const systemSettings: any = {};
  const systemKeys = [
    'PAYMENT_ACCOUNT', 'PRE_DISBURSEMENT_FEE', 'MAX_EXTENSIONS', 
    'UPGRADE_PERCENT', 'FINE_RATE', 'MAX_FINE_PERCENT', 
    'MAX_LOAN_PER_CYCLE', 'MIN_SYSTEM_BUDGET', 'MAX_SINGLE_LOAN_AMOUNT', 'INITIAL_LIMIT',
    'IMGBB_API_KEY', 'PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY',
    'APP_URL', 'JWT_SECRET', 'ADMIN_PHONE', 'ADMIN_PASSWORD',
    'PAYMENT_CONTENT_FULL_SETTLEMENT', 'PAYMENT_CONTENT_PARTIAL_SETTLEMENT',
    'PAYMENT_CONTENT_EXTENSION', 'PAYMENT_CONTENT_UPGRADE',
    'CONTRACT_CODE_FORMAT', 'USER_ID_FORMAT', 'ZALO_GROUP_LINK',
    'SYSTEM_NOTIFICATION', 'SHOW_SYSTEM_NOTIFICATION',
    'ENABLE_PAYOS', 'ENABLE_VIETQR', 'LUCKY_SPIN_VOUCHERS', 'LUCKY_SPIN_WIN_RATE',
    'LUCKY_SPIN_PAYMENTS_REQUIRED', 'MAX_ON_TIME_PAYMENTS_FOR_UPGRADE', 'CONTRACT_CLAUSES',
    'RANK_CONFIG', 'SYSTEM_FORMATS_CONFIG', 'BUSINESS_OPERATIONS_CONFIG',
    'CONTRACT_FORMATS_CONFIG', 'TRANSFER_CONTENTS_CONFIG', 'SYSTEM_CONTRACT_FORMATS_CONFIG', 'MASTER_CONFIGS'
  ];
  
  systemKeys.forEach(key => {
    if (newConfig[key] !== undefined) {
      systemSettings[key] = newConfig[key];
    }
  });
  
  const savedToDb = await saveSystemSettings(client, systemSettings);
  
  // Invalidate cache after save
  settingsCache = null;
  lastCacheUpdate = 0;
  
  // Fetch full merged settings after save to return to client
  const fullSettings = await getMergedSettings(client);
  
  // Emit real-time update to all clients
  const io = req.app.get("io");
  if (io) {
    io.emit("config_updated", fullSettings);
  }
  
  if (savedToDb) {
    res.json({ 
      success: true, 
      message: "Cài đặt đã được lưu vĩnh viễn vào Supabase.",
      settings: fullSettings
    });
  } else {
    // Fallback to file if DB fails
    saveConfig(newConfig);
    res.json({ 
      success: true, 
      message: "Cài đặt đã được lưu vào tệp tin (Lưu ý: Có thể bị mất khi Vercel restart).",
      settings: fullSettings
    });
  }
});

router.get("/check-bank-account", async (req, res) => {
  const { bin, accountNumber } = req.query;
  if (!bin || !accountNumber) {
    return res.status(400).json({ error: "Thiếu thông tin ngân hàng" });
  }

  try {
    // Using VietQR API for bank account lookup
    const response = await fetch("https://api.vietqr.io/v2/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bin, accountNumber })
    });

    const data = await response.json();
    if (data.code === "00" && data.data) {
      res.json({ success: true, accountName: data.data.accountName });
    } else {
      res.status(404).json({ error: "Không tìm thấy tài khoản ngân hàng" });
    }
  } catch (e) {
    console.error("[BANK LOOKUP ERROR]", e);
    res.status(500).json({ error: "Lỗi khi tra cứu tài khoản ngân hàng" });
  }
});

// Helper to get format from settings with priority
const getFormatFromSettings = (settings: any, key: string, defaultValue: string, category?: string) => {
  if (!settings) return defaultValue;
  
  // 1. Check in MASTER_CONFIGS if available
  if (Array.isArray(settings.MASTER_CONFIGS) && settings.MASTER_CONFIGS.length > 0) {
    const config = settings.MASTER_CONFIGS.find((f: any) => {
      const matchCategory = category ? f.category === category : true;
      const matchKey = f.systemMeaning === key || 
                       f.originalName === key || 
                       f.abbreviation === key ||
                       (key === 'user' && f.systemMeaning === 'user_format') ||
                       (key === 'contract' && f.systemMeaning === 'contract_original_format') ||
                       (key === 'PARTIAL_SETTLEMENT' && f.systemMeaning === 'contract_partial_format') ||
                       (key === 'EXTENSION' && f.systemMeaning === 'contract_extension_format') ||
                       (key === 'FULL_SETTLEMENT' && f.systemMeaning === 'transfer_full') ||
                       (key === 'PARTIAL_SETTLEMENT' && f.systemMeaning === 'transfer_partial') ||
                       (key === 'EXTENSION' && f.systemMeaning === 'transfer_extension') ||
                       (key === 'UPGRADE' && f.systemMeaning === 'transfer_upgrade');
      return matchCategory && matchKey;
    });
    if (config) {
      if (category === 'ABBREVIATION') return config.abbreviation;
      return config.format || config.abbreviation || defaultValue;
    }
  }

  // 2. Fallback to legacy config arrays
  const legacyMap: Record<string, string> = {
    'ID_FORMAT': 'SYSTEM_FORMATS_CONFIG',
    'CONTRACT_NEW': 'SYSTEM_CONTRACT_FORMATS_CONFIG',
    'TRANSFER_CONTENT': 'TRANSFER_CONTENTS_CONFIG',
    'ABBREVIATION': 'BUSINESS_OPERATIONS_CONFIG'
  };

  const configArrayKey = category ? legacyMap[category] : null;
  
  if (configArrayKey && Array.isArray(settings[configArrayKey])) {
    const config = settings[configArrayKey].find((f: any) => 
      f.type === key || f.key === key || f.original === key || f.originalName === key
    );
    if (config) return config.value || config.abbr || defaultValue;
  }
  
  // 3. Check direct key
  if (settings[key]) return settings[key];
  
  return defaultValue;
};

// Helper to resolve nested master configurations on server
const getSystemFormatServer = (settings: any, type: 'user' | 'contract', defaultValue: string): string => {
  if (!settings) return defaultValue;
  if (Array.isArray(settings.MASTER_CONFIGS) && settings.MASTER_CONFIGS.length > 0) {
    const config = settings.MASTER_CONFIGS.find((f: any) => 
      f.category === 'ID_FORMAT' && (f.systemMeaning === type || f.systemMeaning === `${type}_format` || f.systemMeaning === `contract_original_format` && type === 'contract')
    );
    if (config) return config.format || defaultValue;
  }
  const config = settings.SYSTEM_FORMATS_CONFIG?.find((f: any) => f.type === type || f.key === (type === 'user' ? 'USER_ID_FORMAT' : 'CONTRACT_CODE_FORMAT') || f.original === (type === 'user' ? 'USER_ID_FORMAT' : 'CONTRACT_CODE_FORMAT'));
  return config?.value || defaultValue;
};

const getSystemContractFormatServer = (settings: any, type: 'PARTIAL_SETTLEMENT' | 'EXTENSION', defaultValue: string): string => {
  if (!settings) return defaultValue;
  if (Array.isArray(settings.MASTER_CONFIGS) && settings.MASTER_CONFIGS.length > 0) {
    const config = settings.MASTER_CONFIGS.find((f: any) => 
      f.category === 'CONTRACT_NEW' && (f.systemMeaning === type || f.systemMeaning === `contract_${type.toLowerCase().replace('_settlement', '')}_format`)
    );
    if (config) return config.format || defaultValue;
  }
  const config = settings.SYSTEM_CONTRACT_FORMATS_CONFIG?.find((f: any) => f.type === type || f.key === type || f.original === type);
  return config?.value || defaultValue;
};

interface ResolutionContextServer {
  userId?: string;
  originalId?: string;
  fullId?: string;
  sequence?: number;
  n?: number;
  slgh?: number;
  slttmp?: number;
  phone?: string;
  rank?: string;
  abbr?: string;
}

const resolveMasterConfigServer = (
  format: string, 
  settings: any, 
  context: ResolutionContextServer = {},
  depth = 0
): string => {
  if (depth > 5) return format; // Prevent infinite loops
  
  let result = format;
  const masterConfigs = Array.isArray(settings?.MASTER_CONFIGS) ? settings.MASTER_CONFIGS : [];
  
  // 1. Replace user-defined variables from ALL categories if they have an abbreviation
  masterConfigs.forEach((cfg: any) => {
    if (cfg.abbreviation) {
      const placeholder = `{${cfg.abbreviation}}`;
      const regex = new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      
      if (regex.test(result)) {
        let replacement = "";
        const type = cfg.systemMeaning;
        const cfgFormat = cfg.format;
        const abbr = cfg.abbreviation.toUpperCase();

        // 1. Smart Fallback: Priority 1 - Use existing data from context if type matches OR if abbreviation is a common system name
        let dataValue = null;
        if (type === 'user_id' && context.userId) dataValue = context.userId;
        if ((type === 'contract_id' || type === 'contract_id_original') && context.originalId) dataValue = context.originalId;
        if (type === 'sequence' && (context.sequence !== undefined || context.n !== undefined)) {
          dataValue = (context.sequence ?? context.n ?? 0).toString();
        }
        if (type === 'phone' && context.phone) dataValue = context.phone;

        if (dataValue === null) {
          if ((abbr === 'US' || abbr === 'USER' || abbr === 'ID') && context.userId) {
            dataValue = context.userId;
          } else if ((abbr === 'MHD' || abbr === 'CONTRACT' || abbr === 'HD') && context.originalId) {
            dataValue = context.originalId;
          } else if (abbr === 'N' && (context.sequence !== undefined || context.n !== undefined)) {
            dataValue = (context.sequence ?? context.n ?? 0).toString();
          }
        }

        if (dataValue !== null) {
          replacement = dataValue;
        } else if (type === 'contract_id_new' || type === 'contract_partial_format' || type === 'contract_extension_format' ||
            type === 'transfer_full' || type === 'transfer_extension' || type === 'transfer_partial' || type === 'transfer_upgrade' || type === 'transfer_disburse') {
          let targetFormat = cfgFormat;
          if (!targetFormat || targetFormat.trim() === "") {
            if (type === 'contract_partial_format') targetFormat = getSystemContractFormatServer(settings, 'PARTIAL_SETTLEMENT', "{MHD}NEW");
            else if (type === 'contract_extension_format') targetFormat = getSystemContractFormatServer(settings, 'EXTENSION', "{MHD}NEW");
            else if (type === 'transfer_full') targetFormat = settings.TRANSFER_CONTENTS_CONFIG?.find((c: any) => c.key === 'FULL_SETTLEMENT')?.value || "TAT TOAN {ID}";
            else if (type === 'transfer_extension') targetFormat = settings.TRANSFER_CONTENTS_CONFIG?.find((c: any) => c.key === 'EXTENSION')?.value || "GIA HAN {ID} LAN {SLGH}";
            else if (type === 'transfer_partial') targetFormat = settings.TRANSFER_CONTENTS_CONFIG?.find((c: any) => c.key === 'PARTIAL_SETTLEMENT')?.value || "TTMP {ID} LAN {SLTTMP}";
            else if (type === 'transfer_upgrade') targetFormat = settings.TRANSFER_CONTENTS_CONFIG?.find((c: any) => c.key === 'UPGRADE')?.value || "HANG {RANK} {USER}";
            else if (type === 'transfer_disburse') targetFormat = settings.TRANSFER_CONTENTS_CONFIG?.find((c: any) => c.key === 'DISBURSE')?.value || "GIAI NGAN {ID}";
            else targetFormat = "{MHD}NEW";
          }
          replacement = resolveMasterConfigServer(targetFormat, settings, context, depth + 1);
        } else if (cfgFormat && cfgFormat.trim() !== "") {
          replacement = resolveMasterConfigServer(cfgFormat, settings, context, depth + 1);
        } else {
          // Otherwise use system logic
          const now = new Date();
          const year = now.getFullYear().toString();
          const month = (now.getMonth() + 1).toString().padStart(2, '0');
          const day = now.getDate().toString().padStart(2, '0');
          const dateStr = `${day}${month}${year.slice(-2)}`;

          switch(type) {
            case 'random':
              const lengthMatch = (cfg.originalName || '')?.match(/\d+/);
              const length = lengthMatch ? parseInt(lengthMatch[0]) : 6;
              let randomNum = '';
              for (let i = 0; i < length; i++) {
                randomNum += Math.floor(Math.random() * 10).toString();
              }
              replacement = randomNum;
              break;
            case 'user_id':
              replacement = context.userId || "USER";
              break;
            case 'contract_id':
            case 'contract_id_original':
              replacement = context.originalId || '';
              break;
            case 'contract_id_new':
              replacement = context.originalId ? `${context.originalId}NEW` : '';
              break;
            case 'sequence':
              replacement = (context.sequence || context.n || 0).toString();
              break;
            case 'date':
            case 'date_now':
              replacement = dateStr;
              break;
            case 'year':
              replacement = year;
              break;
            case 'month':
              replacement = month;
              break;
            case 'day':
              replacement = day;
              break;
            case 'phone':
              replacement = context.phone || "{PHONE}";
              break;
            case 'rank':
              replacement = context.rank || "MEMBER";
              break;
            case 'slgh':
              replacement = (context.slgh || 0).toString();
              break;
            case 'slttmp':
              replacement = (context.slttmp || 0).toString();
              break;
            default:
              replacement = cfg.originalName || "";
          }
        }
        result = result.replace(regex, replacement);
      }
    }
  });

  // 2. Handle system placeholders if not replaced by user variables
  const randomRegex = /\{(RANDOM|MÃ NGẪU NHIÊN|RD)\s*(\d+)?\s*(SỐ)?\}|\{(MHD|RD|HD)\s*(\d+)\s*(SỐ)?\}/gi;
  result = result.replace(randomRegex, (match, p1, p2, p3, p4, p5) => {
    const length = p2 ? parseInt(p2) : (p5 ? parseInt(p5) : 4);
    let randomNum = '';
    for (let i = 0; i < length; i++) {
      randomNum += Math.floor(Math.random() * 10).toString();
    }
    return randomNum;
  });

  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const dateStr = `${day}${month}${year.slice(-2)}`;
  const userPart = context.userId || "USER";

  // Align with utils.ts resolveMasterConfig legacy logic:
  // {ID} and {USER} become userId
  // {MHD} and {CONTRACT} become originalId
  result = result.replace(/\{ID\}|\{USER\}/gi, userPart);
  result = result.replace(/\{MHD\}|\{CONTRACT\}/gi, context.originalId || "HD0001");
  result = result.replace(/\{N\}/gi, (context.sequence !== undefined ? context.sequence : (context.n !== undefined ? context.n : 0)).toString());
  result = result.replace(/\{DATE\}|\{NGÀY\}/gi, dateStr);

  // Final pass for specific payment placeholders (matching utils.ts generatePaymentContent)
  // These only apply if not already replaced by resolveMasterConfig
  const fullId = context.fullId || context.originalId || '';
  result = result
    .replace(/\{Mã Hợp Đồng\}|\{LOAN_ID\}/gi, fullId)
    .replace(/\{PHONE\}|\{SĐT\}|\{SDT\}|\{SỐ ĐIỆN THOẠI\}|\{SO DIEN THOAI\}/gi, context.phone || '')
    .replace(/\{RANK\}|\{HẠNG\}|\{HANG\}|\{TÊN HANG\}|\{TÊN HẠNG\}/gi, context.rank || '')
    .replace(/\{SLGH\}|\{SỐ LẦN GIA HẠN\}|\{EXTENSION_COUNT\}/gi, (context.slgh || 0).toString())
    .replace(/\{SLTTMP\}|\{SỐ LẦN TTMP\}|\{PARTIAL_COUNT\}/gi, (context.slttmp || 0).toString())
    .replace(/\{VT\}|\{VIẾT TẮT\}|\{VIET TAT\}/gi, context.abbr || '')
    .replace(/\{N\}|\{SEQUENCE\}/gi, (context.sequence || context.n || 0).toString());

  return result;
};

const generateUserIdServer = (format = '{RANDOM 6 SỐ}', settings?: any) => {
  return resolveMasterConfigServer(format, settings, {});
};

const generateContractIdServer = (userId: string, format = 'HD-{MHD}', settings?: any, loanId?: string, seq?: number, n?: number, slgh?: number, slttmp?: number) => {
  return resolveMasterConfigServer(format, settings, { userId, originalId: loanId, sequence: seq || n, n, slgh, slttmp });
};

router.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body;
    
    if (!phone || !password) {
      return res.status(400).json({ error: "Vui lòng nhập đầy đủ số điện thoại và mật khẩu." });
    }
    
    const client = initSupabase();
    const settings = await getMergedSettings(client);
    
    // 1. Try to find user in Supabase first
    if (client) {
      const { data: users, error } = await client
        .from('users')
        .select('*')
        .eq('phone', phone)
        .limit(1);

      if (error) {
        console.error("[SUPABASE ERROR] Login query failed:", JSON.stringify(error));
      } else if (users && users.length > 0) {
        const user = users[0];
        
        // Check password
        if (user.password && typeof user.password === 'string') {
          try {
            // Robust check for bcrypt hash: starts with $2a$, $2b$, or $2y$, has 2-digit cost, and 53 base64 characters
            const isBcryptHash = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.password);
            
            let isMatch = false;
            if (isBcryptHash) {
              try {
                isMatch = await bcrypt.compare(String(password), user.password);
              } catch (compareError) {
                console.warn("[LOGIN] Bcrypt compare failed, falling back to plain text:", compareError);
                isMatch = String(password) === user.password;
              }
            } else {
              // Fallback for plain text passwords
              isMatch = String(password) === user.password;
              
              // If it matched plain text, we should ideally hash it now for future use
              if (isMatch) {
                console.log(`[LOGIN] Migrating plain text password for user ${user.id}`);
                try {
                  const salt = await bcrypt.genSalt(10);
                  const hashedPassword = await bcrypt.hash(String(password), salt);
                  await client.from('users').update({ password: hashedPassword }).eq('id', user.id);
                } catch (migrationError) {
                  console.error("[LOGIN] Failed to migrate password:", migrationError);
                }
              }
            }

            if (isMatch) {
              // Remove password before sending
              const { password: _, ...userWithoutPassword } = user;
              const isAdmin = user.isAdmin === true;
              const token = jwt.sign({ id: user.id, isAdmin }, settings.JWT_SECRET, { expiresIn: '24h' });
              
              return res.json({
                success: true,
                user: { ...userWithoutPassword, isAdmin },
                token
              });
            } else {
              return res.status(401).json({ error: "Số điện thoại hoặc mật khẩu không chính xác." });
            }
          } catch (bcryptError: any) {
            console.error("[BCRYPT ERROR] Failed to compare password for user:", user.id, bcryptError);
            // Handle specific bcrypt error that might be caused by malformed hash
            const errorMsg = (bcryptError.message || String(bcryptError)).toLowerCase();
            if (errorMsg.includes("pattern") || errorMsg.includes("expected") || errorMsg.includes("invalid") || errorMsg.includes("atob")) {
              return res.status(401).json({ 
                error: "Dữ liệu tài khoản không hợp lệ", 
                message: "Cấu trúc mật khẩu trong hệ thống bị lỗi. Vui lòng liên hệ Admin để đặt lại mật khẩu." 
              });
            }
            throw bcryptError;
          }
        }
      }
    } else {
      console.warn("[LOGIN] Supabase client not initialized. Falling back to hardcoded admin check.");
    }
    
    // 2. Fallback to hardcoded Admin check if Supabase check fails or user not found
    // This ensures admin can always log in to fix configuration
    if (phone === settings.ADMIN_PHONE && password === settings.ADMIN_PASSWORD) {
      const adminUser = {
        id: 'AD01', phone: settings.ADMIN_PHONE, fullName: 'QUẢN TRỊ VIÊN', idNumber: 'SYSTEM_ADMIN',
        balance: 500000000, totalLimit: 500000000, rank: 'diamond', rankProgress: 10,
        isLoggedIn: true, isAdmin: true
      };
      const token = jwt.sign({ id: adminUser.id, isAdmin: true }, settings.JWT_SECRET, { expiresIn: '24h' });
      return res.json({
        success: true,
        user: adminUser,
        token
      });
    }

    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    return res.status(401).json({ error: "Số điện thoại hoặc mật khẩu không chính xác." });

  } catch (e: any) {
    console.error("[LOGIN FATAL ERROR]:", e);
    res.status(500).json({ 
      error: "Lỗi hệ thống", 
      message: e.message || "Đã xảy ra lỗi không xác định trong quá trình đăng nhập" 
    });
  }
});

router.post("/register", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const settings = await getMergedSettings(client);
    
    const userData = req.body;
    if (!userData || !userData.phone || !userData.password) {
      return res.status(400).json({ error: "Thiếu thông tin đăng ký" });
    }

    // Check if user already exists (by phone, Zalo, or ID Number)
    let query = client.from('users').select('id, phone, "refZalo", "idNumber"');
    const conditions = [`phone.eq.${userData.phone}`];
    if (userData.refZalo) conditions.push(`refZalo.eq.${userData.refZalo}`);
    if (userData.idNumber) conditions.push(`idNumber.eq.${userData.idNumber}`);
    
    query = query.or(conditions.join(','));
    
    const { data: existingUsers, error: checkError } = await query.limit(1);
    
    if (checkError) throw checkError;
    if (existingUsers && existingUsers.length > 0) {
      const existing = existingUsers[0];
      if (existing.phone === userData.phone) {
        return res.status(400).json({ error: "Số điện thoại này đã được đăng ký." });
      } else if (userData.refZalo && existing.refZalo === userData.refZalo) {
        return res.status(400).json({ error: "Số Zalo này đã được sử dụng bởi một tài khoản khác." });
      } else {
        return res.status(400).json({ error: "Số CCCD/CMND này đã được sử dụng bởi một tài khoản khác." });
      }
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(userData.password, salt);

    // Ensure ID follows Admin format if not already set correctly
    let userId = userData.id;
    const format = getFormatFromSettings(settings, 'user', '{RANDOM 6 SỐ}', 'SYSTEM_FORMATS_CONFIG');
    if (!userId || userId.startsWith('TEMP-')) {
      userId = generateUserIdServer(format, settings);
    }

    const newUser = {
      ...userData,
      id: userId,
      password: hashedPassword,
      updatedAt: Date.now()
    };

    const sanitizedUser = sanitizeData([newUser], USER_WRITE_COLUMNS)[0];
    
    console.log(`[API] Registering user: ${sanitizedUser.id} (${sanitizedUser.phone})`);
    
    const { error: insertError } = await client.from('users').insert(sanitizedUser);
    if (insertError) {
      console.error("[API ERROR] Supabase insert failed for user:", JSON.stringify(insertError));
      throw insertError;
    }

    console.log(`[API] User ${sanitizedUser.id} registered successfully in Supabase.`);

    const token = jwt.sign({ id: sanitizedUser.id, isAdmin: false }, settings.JWT_SECRET, { expiresIn: '24h' });
    
    res.json({
      success: true,
      token
    });
  } catch (e: any) {
    console.error("Lỗi register:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

let lastPingTime = 0;
const PING_INTERVAL = 1 * 60 * 60 * 1000; // 1 hour

// Passive Keep-Alive Middleware
router.use(async (req, res, next) => {
  const now = Date.now();
  if (now - lastPingTime > PING_INTERVAL) {
    lastPingTime = now;
    // Don't await, let it run in background
    keepAliveSupabase().catch(e => console.error("[Passive-Keep-Alive] Error:", e));
  }
  next();
});

router.get("/data", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) {
      return res.status(500).json({
        error: "Cấu hình Supabase không hợp lệ",
        message: "Hệ thống chưa được cấu hình Supabase URL hoặc Service Role Key."
      });
    }

    const userId = req.query.userId as string;
    const isAdmin = (req as any).user?.isAdmin === true || req.query.isAdmin === 'true';
    const isBackup = isAdmin && req.query.backup === 'true';

    // Individual query functions with role-based filtering and pagination
    const fetchUsers = async () => {
      try {
        const from = parseInt(req.query.userFrom as string) || 0;
        const to = parseInt(req.query.userTo as string) || (req.query.full === 'true' ? 999 : 19);

        // Security: Only fetch full columns if explicitly requested (e.g. for profile or admin edit)
        // AND ensure password is NEVER included in data fetch unless it's an admin backup
        let columnsList = (req.query.full === 'true' ? USER_COLUMNS : USER_SUMMARY_COLUMNS);
        
        if (isBackup) {
          columnsList = USER_WRITE_COLUMNS;
        } else {
          columnsList = columnsList.filter(c => c !== 'password');
        }
        
        const columns = columnsList.join(',');
          
        let query = client.from('users').select(columns);
        
        // SECURITY: If not admin, ONLY allow fetching own data
        if (!isAdmin) {
          if (!userId) return [];
          query = query.eq('id', userId);
        } else {
          // Pagination for admin
          query = query.order('id', { ascending: true }).range(from, to);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch users:", e.message || e);
        return [];
      }
    };

    const fetchLoans = async () => {
      try {
        const from = parseInt(req.query.loanFrom as string) || 0;
        const to = parseInt(req.query.loanTo as string) || (req.query.full === 'true' ? 999 : 19);

        const columns = req.query.full === 'true' ? LOAN_COLUMNS.join(',') : LOAN_SUMMARY_COLUMNS.join(',');
        let query = client.from('loans').select(columns);
        if (!isAdmin && userId) {
          query = query.eq('userId', userId);
        } else if (isAdmin) {
          // Pagination for admin
          query = query.order('id', { ascending: false }).range(from, to);
        }
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch loans:", e.message || e);
        return [];
      }
    };

    const fetchNotifications = async () => {
      try {
        const from = parseInt(req.query.notifFrom as string) || 0;
        const to = parseInt(req.query.notifTo as string) || 19;

        const columns = req.query.full === 'true' ? NOTIFICATION_COLUMNS.join(',') : NOTIFICATION_SUMMARY_COLUMNS.join(',');
        let query = client.from('notifications').select(columns).order('id', { ascending: false });
        if (!isAdmin && userId) {
          query = query.eq('userId', userId);
        }
        const { data, error } = await query.range(from, to);
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch notifications:", e.message || e);
        return [];
      }
    };

    const fetchConfig = async () => {
      try {
        // Use loadSystemSettings which has caching
        const settings = await loadSystemSettings(client);
        return Object.entries(settings).map(([key, value]) => ({ key, value }));
      } catch (e: any) {
        console.error("Lỗi fetch config:", e.message || e);
        return [];
      }
    };

    const fetchBudgetLogs = async () => {
      if (!isAdmin) return []; // Only admin needs budget logs
      try {
        const { data, error } = await client.from('budget_logs')
          .select('*')
          .order('createdAt', { ascending: false })
          .limit(30); // Reduced from 50 to 30 for faster initial load
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch budget logs:", e.message || e);
        return [];
      }
    };

    // Parallelize queries
    const start = Date.now();
    const [users, loans, notifications, config, budgetLogs] = await Promise.all([
      fetchUsers(),
      fetchLoans(),
      fetchNotifications(),
      fetchConfig(),
      fetchBudgetLogs()
    ]);
    const end = Date.now();
    console.log(`[API] Data fetch took ${end - start}ms. Users: ${users.length}, Loans: ${loans.length}`);

    const budget = Number(config?.find(c => c.key === 'SYSTEM_BUDGET')?.value || config?.find(c => c.key === 'budget')?.value) || 0;
    const rankProfit = Number(config?.find(c => c.key === 'TOTAL_RANK_PROFIT')?.value || config?.find(c => c.key === 'rankProfit')?.value) || 0;
    const loanProfit = Number(config?.find(c => c.key === 'TOTAL_LOAN_PROFIT')?.value || config?.find(c => c.key === 'loanProfit')?.value) || 0;
    const monthlyStats = config?.find(c => c.key === 'MONTHLY_STATS')?.value || config?.find(c => c.key === 'monthlyStats')?.value || [];
    const lastKeepAlive = config?.find(c => c.key === 'lastKeepAlive')?.value || null;

    const payload = {
      users,
      loans,
      notifications,
      budget,
      rankProfit,
      loanProfit,
      monthlyStats,
      lastKeepAlive,
      budgetLogs
    };

    // Only calculate storage usage if explicitly requested
    let usage = 0;
    if (req.query.checkStorage === 'true') {
      usage = getStorageUsage(payload);
    }
    
    const isFull = usage > STORAGE_LIMIT_MB;

    // Run cleanup in background if usage is high
    if (usage > STORAGE_LIMIT_MB * 0.8) {
      autoCleanupStorage();
    }

    sendSafeJson(res, {
      ...payload,
      storageFull: isFull,
      storageUsage: usage.toFixed(2)
    });
  } catch (e: any) {
    console.error("Lỗi nghiêm trọng trong /api/data:", e);
    res.status(500).json({ 
      error: "Lỗi hệ thống", 
      message: `Đã xảy ra lỗi nghiêm trọng: ${e.message || "Không xác định"}. Vui lòng kiểm tra lại kết nối Supabase.` 
    });
  }
});

router.post("/users", async (req: any, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const incomingUsers = req.body;
    if (!Array.isArray(incomingUsers)) {
      return res.status(400).json({ error: "Dữ liệu phải là mảng" });
    }

    // Security check: If not admin, can only update own record
    if (!req.user?.isAdmin) {
      const otherUser = incomingUsers.find(u => u.id !== req.user.id);
      if (otherUser) {
        return res.status(403).json({ error: "Bạn không có quyền cập nhật dữ liệu của người khác" });
      }
    }

    // Hash passwords for new users
    const processedUsers = await Promise.all(incomingUsers.map(async (u) => {
      // Robust check for bcrypt hash: starts with $2a$, $2b$, or $2y$ and has correct length
      const isAlreadyHashed = typeof u.password === 'string' && 
                             /^\$2[aby]\$\d+\$.{53}$/.test(u.password);
                             
      if (u.password && typeof u.password === 'string' && !isAlreadyHashed) {
        const salt = await bcrypt.genSalt(10);
        u.password = await bcrypt.hash(u.password, salt);
      }
      return u;
    }));

    const sanitizedUsers = sanitizeData(processedUsers, USER_WRITE_COLUMNS);
    if (sanitizedUsers.length === 0) {
      return res.status(400).json({ error: "Không có dữ liệu hợp lệ để lưu" });
    }

    console.log(`[API] Syncing ${sanitizedUsers.length} users to Supabase...`);
    
    // Bulk upsert with fallback for missing columns
    const { error } = await client.from('users').upsert(sanitizedUsers, { onConflict: 'id' });
    if (error) {
      console.error("[API ERROR] Supabase upsert failed for users:", JSON.stringify(error));
      
      // If it's a missing column error, try again without the new columns
      if (error.code === '42703' || (error.message && (error.message.includes('column') && error.message.includes('does not exist')))) {
        console.warn("[API] Retrying users upsert without potentially missing columns...");
        // Identify common new columns that might be missing
        const commonNewColumns = ['payosOrderCode', 'payosCheckoutUrl', 'payosAmount', 'payosExpireAt', 'idNumber', 'refZalo', 'spins', 'vouchers', 'totalProfit', 'fullSettlementCount'];
        const fallbackColumns = USER_WRITE_COLUMNS.filter(c => !commonNewColumns.some(nc => error.message.includes(nc)));
        
        // If we couldn't identify specific columns from the error message, just remove all common new ones
        const saferColumns = fallbackColumns.length === USER_WRITE_COLUMNS.length 
          ? USER_WRITE_COLUMNS.filter(c => !commonNewColumns.includes(c))
          : fallbackColumns;
          
        const saferUsers = sanitizeData(processedUsers, saferColumns);
        const { error: retryError } = await client.from('users').upsert(saferUsers, { onConflict: 'id' });
        
        if (retryError) {
          return res.status(500).json({ 
            error: "Lỗi cơ sở dữ liệu", 
            message: retryError.message, 
            code: retryError.code 
          });
        }
      } else {
        return res.status(500).json({ 
          error: "Lỗi cơ sở dữ liệu", 
          message: error.message, 
          code: error.code,
          hint: error.hint || "Hãy đảm bảo bạn đã chạy SQL schema trong Supabase SQL Editor."
        });
      }
    }

    console.log(`[API] Users synced successfully.`);
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      sanitizedUsers.forEach(u => {
        io.to(`user_${u.id}`).emit("user_updated", u);
      });
      io.to("admin").emit("users_updated", sanitizedUsers);
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/users:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/loans", async (req: any, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const incomingLoans = req.body;
    if (!Array.isArray(incomingLoans)) {
      return res.status(400).json({ error: "Dữ liệu phải là mảng" });
    }

    // Security check: If not admin, can only update own loans
    if (!req.user?.isAdmin) {
      const otherLoan = incomingLoans.find(l => l.userId !== req.user.id);
      if (otherLoan) {
        return res.status(403).json({ error: "Bạn không có quyền cập nhật khoản vay của người khác" });
      }
    }

    // Anti-replay check for bankTransactionId
    for (const loan of incomingLoans) {
      if (loan.bankTransactionId) {
        const { data: existing, error: checkError } = await client
          .from('loans')
          .select('id')
          .eq('bankTransactionId', loan.bankTransactionId)
          .neq('id', loan.id)
          .limit(1);
        
        if (checkError) {
          console.error("Lỗi check bankTransactionId:", JSON.stringify(checkError));
        } else if (existing && existing.length > 0) {
          return res.status(400).json({ 
            error: "Giao dịch đã tồn tại", 
            message: `Mã giao dịch ${loan.bankTransactionId} đã được sử dụng cho một khoản vay khác. Vui lòng kiểm tra lại.` 
          });
        }
      }
    }

    const sanitizedLoans = sanitizeData(incomingLoans, LOAN_COLUMNS);
    if (sanitizedLoans.length === 0) {
      return res.status(400).json({ error: "Không có dữ liệu hợp lệ để lưu" });
    }

    // Budget check for new loans (if not admin)
    if (!req.user?.isAdmin) {
      const isNewLoan = sanitizedLoans.some(l => l.status === 'CHỜ DUYỆT');
      if (isNewLoan) {
        const settings = await getMergedSettings(client);
        const minBudget = Number(settings.MIN_SYSTEM_BUDGET || 1000000);
        const currentBudget = Number(settings.SYSTEM_BUDGET || 0);
        
        if (currentBudget < minBudget) {
          return res.status(400).json({ 
            error: "Hệ thống bảo trì", 
            message: "Hệ thống đang bảo trì nguồn vốn. Vui lòng quay lại sau." 
          });
        }
      }
    }

    // Bulk upsert with fallback for missing columns
    const { error } = await client.from('loans').upsert(sanitizedLoans, { onConflict: 'id' });
    if (error) {
      console.error("Lỗi upsert loans:", JSON.stringify(error));
      
      // If it's a missing column error, try again without the new columns
      if (error.code === '42703' || (error.message && (error.message.includes('column') && error.message.includes('does not exist')))) {
        console.warn("[API] Retrying loans upsert without potentially missing columns...");
        // Identify common new columns that might be missing
        const commonNewColumns = ['principalPaymentCount', 'partialAmount', 'partialPaymentCount', 'extensionCount', 'originalBaseId', 'payosOrderCode', 'payosCheckoutUrl', 'payosAmount', 'payosExpireAt', 'voucherId', 'settledAt'];
        const fallbackColumns = LOAN_COLUMNS.filter(c => !commonNewColumns.some(nc => error.message.includes(nc)));
        
        // If we couldn't identify specific columns from the error message, just remove all common new ones
        const saferColumns = fallbackColumns.length === LOAN_COLUMNS.length 
          ? LOAN_COLUMNS.filter(c => !commonNewColumns.includes(c))
          : fallbackColumns;
          
        const saferLoans = sanitizeData(incomingLoans, saferColumns);
        const { error: retryError } = await client.from('loans').upsert(saferLoans, { onConflict: 'id' });
        
        if (retryError) {
          return res.status(500).json({ 
            error: "Lỗi cơ sở dữ liệu", 
            message: retryError.message, 
            code: retryError.code 
          });
        }
      } else {
        return res.status(500).json({ 
          error: "Lỗi cơ sở dữ liệu", 
          message: error.message, 
          code: error.code,
          hint: error.hint || "Hãy đảm bảo bạn đã chạy SQL schema trong Supabase SQL Editor."
        });
      }
    }
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      sanitizedLoans.forEach(l => {
        io.to(`user_${l.userId}`).emit("loan_updated", l);
      });
      io.to("admin").emit("loans_updated", sanitizedLoans);
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/loans:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/notifications", async (req: any, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const incomingNotifs = req.body;
    if (!Array.isArray(incomingNotifs)) {
      return res.status(400).json({ error: "Dữ liệu phải là mảng" });
    }

    // Security check: If not admin, can only update own notifications
    if (!req.user?.isAdmin) {
      const otherNotif = incomingNotifs.find(n => n.userId !== req.user.id);
      if (otherNotif) {
        return res.status(403).json({ error: "Bạn không có quyền cập nhật thông báo của người khác" });
      }
    }

    const sanitizedNotifs = sanitizeData(incomingNotifs, NOTIFICATION_COLUMNS);
    if (sanitizedNotifs.length === 0) {
      return res.status(400).json({ error: "Không có dữ liệu hợp lệ để lưu" });
    }

    // Bulk upsert
    const { error } = await client.from('notifications').upsert(sanitizedNotifs, { onConflict: 'id' });
    if (error) {
      console.error("Lỗi upsert notifications:", JSON.stringify(error));
      return res.status(500).json({ 
        error: "Lỗi cơ sở dữ liệu", 
        message: error.message, 
        code: error.code,
        hint: error.hint || "Hãy đảm bảo bạn đã chạy SQL schema trong Supabase SQL Editor."
      });
    }
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      sanitizedNotifs.forEach(n => {
        io.to(`user_${n.userId}`).emit("notification_updated", n);
      });
      io.to("admin").emit("notifications_updated", sanitizedNotifs);
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/notifications:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/budget", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { budget, log } = req.body;
    const { error } = await client.from('config').upsert({ key: 'SYSTEM_BUDGET', value: budget }, { onConflict: 'key' });
    if (error) throw error;

    if (log) {
      const sanitizedLog = sanitizeData([log], BUDGET_LOG_COLUMNS)[0];
      if (sanitizedLog) {
        await client.from('budget_logs').upsert(sanitizedLog, { onConflict: 'id' });
      }
    }

    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/budget:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/rankProfit", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { rankProfit } = req.body;
    const { error } = await client.from('config').upsert({ key: 'TOTAL_RANK_PROFIT', value: rankProfit }, { onConflict: 'key' });
    if (error) throw error;
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/rankProfit:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/loanProfit", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { loanProfit } = req.body;
    const { error } = await client.from('config').upsert({ key: 'TOTAL_LOAN_PROFIT', value: loanProfit }, { onConflict: 'key' });
    if (error) throw error;
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/loanProfit:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/monthlyStats", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { monthlyStats } = req.body;
    const { error } = await client.from('config').upsert({ key: 'MONTHLY_STATS', value: monthlyStats }, { onConflict: 'key' });
    if (error) throw error;
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/monthlyStats:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.delete("/users/:id", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const userId = req.params.id;
    
    // Delete children first due to foreign key constraints
    await client.from('loans').delete().eq('userId', userId);
    await client.from('notifications').delete().eq('userId', userId);
    await client.from('users').delete().eq('id', userId);
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong DELETE /api/users/:id:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// Helper to filter object keys based on allowed columns
const sanitizeData = (data: any[], allowedColumns: string[]) => {
  if (!Array.isArray(data)) return [];
  return data.map(item => {
    if (!item || typeof item !== 'object') return null;
    const sanitized: any = {};
    allowedColumns.forEach(col => {
      if (Object.prototype.hasOwnProperty.call(item, col)) {
        sanitized[col] = item[col];
      }
    });
    return sanitized;
  }).filter(item => item && item.id); // Ensure ID exists and item is not null
};

const USER_COLUMNS = [
  'id', 'phone', 'fullName', 'idNumber', 'balance', 'totalLimit', 'rank', 
  'rankProgress', 'isLoggedIn', 'isAdmin', 'pendingUpgradeRank', 
  'rankUpgradeBill', 'avatar', 'address', 'joinDate', 'idFront', 'idBack', 
  'refZalo', 'relationship', 'lastLoanSeq', 'bankName', 'bankBin', 
  'bankAccountNumber', 'bankAccountHolder', 'hasJoinedZalo', 
  'payosOrderCode', 'payosCheckoutUrl', 'payosAmount', 'payosExpireAt', 
  'spins', 'vouchers', 'totalProfit', 'fullSettlementCount', 'updatedAt'
];

const USER_WRITE_COLUMNS = [...USER_COLUMNS, 'password'];

const USER_SUMMARY_COLUMNS = [
  'id', 'phone', 'fullName', 'idNumber', 'balance', 'totalLimit', 'rank', 
  'rankProgress', 'isLoggedIn', 'isAdmin', 'pendingUpgradeRank', 'rankUpgradeBill', 'avatar',
  'address', 'joinDate', 'idFront', 'idBack', 'refZalo', 'relationship', 'lastLoanSeq', 'bankName', 'bankBin', 
  'bankAccountNumber', 'bankAccountHolder', 'hasJoinedZalo', 'spins', 'vouchers', 'totalProfit', 'fullSettlementCount', 'updatedAt'
];

const LOAN_COLUMNS = [
  'id', 'userId', 'userName', 'amount', 'date', 'createdAt', 'status', 
  'fine', 'billImage', 'bankTransactionId', 'signature', 'loanPurpose', 'rejectionReason', 
  'settlementType', 'partialAmount', 'voucherId', 'settledAt', 'principalPaymentCount', 'extensionCount', 'partialPaymentCount',
  'originalBaseId', 'payosOrderCode', 'payosCheckoutUrl', 'payosAmount', 'payosExpireAt', 'updatedAt'
];

const LOAN_SUMMARY_COLUMNS = [
  'id', 'userId', 'userName', 'amount', 'date', 'createdAt', 'status', 
  'fine', 'bankTransactionId', 'rejectionReason', 'billImage', 'signature', 'loanPurpose',
  'settlementType', 'partialAmount', 'voucherId', 'settledAt', 'principalPaymentCount', 'extensionCount', 'partialPaymentCount', 'originalBaseId', 'updatedAt'
];

const NOTIFICATION_COLUMNS = [
  'id', 'userId', 'title', 'message', 'time', 'read', 'type'
];

const NOTIFICATION_SUMMARY_COLUMNS = [
  'id', 'userId', 'title', 'time', 'read', 'type'
];

const BUDGET_LOG_COLUMNS = [
  'id', 'type', 'amount', 'balanceAfter', 'note', 'createdAt'
];

router.post("/sync", async (req: any, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { users, loans, notifications, budget, budgetLog, rankProfit, loanProfit, monthlyStats } = req.body;
    
    const isAdmin = req.user?.isAdmin === true;

    // Security check for non-admin sync
    if (!isAdmin) {
      // Non-admins cannot update system config
      if (budget !== undefined || budgetLog !== undefined || rankProfit !== undefined || loanProfit !== undefined || monthlyStats !== undefined) {
        return res.status(403).json({ error: "Bạn không có quyền cập nhật cấu hình hệ thống" });
      }
      
      // Non-admins can only update their own data
      if (users && Array.isArray(users)) {
        if (users.some(u => u.id !== req.user.id)) {
          return res.status(403).json({ error: "Bạn không có quyền cập nhật dữ liệu của người khác" });
        }
      }
      
      if (loans && Array.isArray(loans)) {
        if (loans.some(l => l.userId !== req.user.id)) {
          return res.status(403).json({ error: "Bạn không có quyền cập nhật khoản vay của người khác" });
        }
      }
      
      if (notifications && Array.isArray(notifications)) {
        if (notifications.some(n => n.userId !== req.user.id)) {
          return res.status(403).json({ error: "Bạn không có quyền cập nhật thông báo của người khác" });
        }
      }
    }

    // Use a sequential approach for critical updates to prevent race conditions
    // and ensure data integrity under high load
    
    // 1. Update Config first (Budget is critical)
    const configUpdates = [];
    if (budget !== undefined) {
      // Security: Validate budget change if it's a decrease (disbursement)
      if (budgetLog && budgetLog.type === 'LOAN_DISBURSE') {
        const { data: currentBudgetData } = await client.from('config').select('value').eq('key', 'SYSTEM_BUDGET').single();
        const currentBudget = Number(currentBudgetData?.value || 0);
        if (budget > currentBudget) {
          console.error("[SYNC] Security Alert: Client tried to increase budget during disbursement");
          return res.status(400).json({ error: "Dữ liệu ngân sách không hợp lệ" });
        }
      }
      configUpdates.push({ key: 'SYSTEM_BUDGET', value: budget });
    }
    if (rankProfit !== undefined) configUpdates.push({ key: 'TOTAL_RANK_PROFIT', value: rankProfit });
    if (loanProfit !== undefined) configUpdates.push({ key: 'TOTAL_LOAN_PROFIT', value: loanProfit });
    if (monthlyStats !== undefined) configUpdates.push({ key: 'MONTHLY_STATS', value: monthlyStats });
    
    if (configUpdates.length > 0) {
      const { error } = await client.from('config').upsert(configUpdates, { onConflict: 'key' });
      if (error) throw error;
      // Invalidate cache
      settingsCache = null;
    }

    // 2. Update Budget Log
    if (budgetLog) {
      const sanitizedLog = sanitizeData([budgetLog], BUDGET_LOG_COLUMNS)[0];
      if (sanitizedLog) {
        const { error } = await client.from('budget_logs').upsert(sanitizedLog, { onConflict: 'id' });
        if (error) {
          console.error("[SYNC] Budget log upsert failed:", JSON.stringify(error));
        }
      }
    }

    // 3. Update Users
    if (users && Array.isArray(users) && users.length > 0) {
      // Hash passwords for users in sync if they are not already hashed
      const processedUsers = await Promise.all(users.map(async (u) => {
        const isAlreadyHashed = typeof u.password === 'string' && /^\$2[aby]\$\d+\$.{53}$/.test(u.password);
        if (u.password && typeof u.password === 'string' && !isAlreadyHashed) {
          const salt = await bcrypt.genSalt(10);
          u.password = await bcrypt.hash(u.password, salt);
        }
        return u;
      }));
      
      const sanitizedUsers = sanitizeData(processedUsers, USER_WRITE_COLUMNS);
      if (sanitizedUsers.length > 0) {
        const { error } = await client.from('users').upsert(sanitizedUsers, { onConflict: 'id' });
        if (error) {
          console.error("[SYNC] Users upsert failed:", JSON.stringify(error));
          throw error;
        }
      }
    }
    
    // 4. Update Loans
    if (loans && Array.isArray(loans) && loans.length > 0) {
      const sanitizedLoans = sanitizeData(loans, LOAN_COLUMNS);
      if (sanitizedLoans.length > 0) {
        const { error } = await client.from('loans').upsert(sanitizedLoans, { onConflict: 'id' });
        if (error) {
          console.error("[SYNC] Loans upsert failed:", JSON.stringify(error));
          // If it's a missing column error, try again without the new columns
          if (error.code === '42703' || (error.message && (error.message.includes('column "principalPaymentCount" does not exist') || error.message.includes('column "partialAmount" does not exist')))) {
            console.warn("[SYNC] Retrying loans upsert without new columns...");
            const fallbackColumns = LOAN_COLUMNS.filter(c => c !== 'principalPaymentCount' && c !== 'partialAmount');
            const saferLoans = sanitizeData(loans, fallbackColumns);
            const { error: retryError } = await client.from('loans').upsert(saferLoans, { onConflict: 'id' });
            if (retryError) throw retryError;
          } else {
            throw error;
          }
        }
      }
    }
    
    // 5. Update Notifications
    if (notifications && Array.isArray(notifications) && notifications.length > 0) {
      const sanitizedNotifications = sanitizeData(notifications, NOTIFICATION_COLUMNS);
      if (sanitizedNotifications.length > 0) {
        const { error } = await client.from('notifications').upsert(sanitizedNotifications, { onConflict: 'id' });
        if (error) {
          console.error("[SYNC] Notifications upsert failed:", JSON.stringify(error));
          throw error;
        }
      }
    }
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      if (users) users.forEach((u: any) => io.to(`user_${u.id}`).emit("user_updated", u));
      if (loans) loans.forEach((l: any) => io.to(`user_${l.userId}`).emit("loan_updated", l));
      if (notifications) notifications.forEach((n: any) => io.to(`user_${n.userId}`).emit("notification_updated", n));
      
      // Always notify admin of sync
      io.to("admin").emit("sync_completed", { users, loans, notifications, configUpdates });
      
      // If config changed, notify everyone or just admin? Usually budget affects everyone
      if (configUpdates.length > 0) {
        io.emit("config_updated", configUpdates);
      }
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/sync:", e);
    res.status(500).json({ 
      success: false,
      error: "Internal Server Error", 
      message: e.message || "Lỗi đồng bộ dữ liệu"
    });
  }
});

router.post("/reset", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    
    // Delete all data except admin
    // Must delete children first due to foreign key constraints
    await client.from('loans').delete().neq('id', 'KEEP_NONE');
    await client.from('notifications').delete().neq('id', 'KEEP_NONE');
    await client.from('budget_logs').delete().neq('id', 'KEEP_NONE');
    await client.from('users').delete().eq('isAdmin', false);
    
    // Reset config values
    await Promise.all([
      client.from('config').upsert({ key: 'SYSTEM_BUDGET', value: 0 }, { onConflict: 'key' }),
      client.from('config').upsert({ key: 'TOTAL_RANK_PROFIT', value: 0 }, { onConflict: 'key' }),
      client.from('config').upsert({ key: 'TOTAL_LOAN_PROFIT', value: 0 }, { onConflict: 'key' }),
      client.from('config').upsert({ key: 'MONTHLY_STATS', value: [] }, { onConflict: 'key' })
    ]);
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/reset:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/execute-sql", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: "Thiếu mã SQL" });

    // Try to execute via RPC
    const { error } = await client.rpc('exec_sql', { sql_query: sql });
    
    if (error) {
      console.error("[SQL EXEC ERROR]", error);
      // Check if function doesn't exist
      if (error.code === 'PGRST202' || error.message?.includes('function') && error.message?.includes('does not exist')) {
        return res.status(400).json({ 
          error: "RPC_NOT_FOUND", 
          message: "Tính năng tự động cập nhật chưa được kích hoạt. Vui lòng chạy lệnh SQL khởi tạo một lần duy nhất trong Supabase SQL Editor." 
        });
      }
      return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: "Thực thi SQL thành công." });
  } catch (e: any) {
    console.error("Lỗi thực thi SQL:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/migrate", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    
    console.log("[Migration] Checking database structure...");
    
    // Check loans table
    const { error: loanError } = await client.from('loans').select('principalPaymentCount, partialAmount, payosOrderCode, payosCheckoutUrl, payosAmount, payosExpireAt, extensionCount, partialPaymentCount, originalBaseId, voucherId, settledAt').limit(1);
    
    if (loanError && loanError.code === '42703') {
      return res.status(400).json({
        success: false,
        error: "Missing Column in Loans",
        message: "Bảng 'loans' thiếu một số cột cần thiết cho PayOS hoặc quản lý thanh toán. Vui lòng chạy SQL Schema đầy đủ trong Supabase SQL Editor."
      });
    }

    // Check users table
    const { error: userError } = await client.from('users').select('payosOrderCode, payosCheckoutUrl, payosAmount, payosExpireAt, pendingUpgradeRank, rankUpgradeBill').limit(1);
    
    if (userError && userError.code === '42703') {
      return res.status(400).json({
        success: false,
        error: "Missing Column in Users",
        message: "Bảng 'users' thiếu một số cột cần thiết cho PayOS hoặc nâng hạng. Vui lòng chạy SQL Schema đầy đủ trong Supabase SQL Editor."
      });
    }
    
    const { error: configError } = await client.from('config').select('key').limit(1);
    if (configError && configError.code === 'PGRST116') {
      // Table might exist but is empty, that's fine
    } else if (configError) {
      console.warn("[Migration] Config table check error:", configError);
    }

    res.json({ success: true, message: "Cấu trúc cơ sở dữ liệu đã chính xác." });
  } catch (e: any) {
    console.error("Lỗi trong /api/migrate:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/import", async (req: any, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: "Chỉ Admin mới có quyền thực hiện thao tác này" });
    }
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { users, loans, notifications, budget, rankProfit, loanProfit, monthlyStats } = req.body;
    
    // 1. Upsert users first to satisfy foreign key constraints in loans/notifications
    if (users && Array.isArray(users) && users.length > 0) {
      // Hash passwords if they are not already hashed
      const processedUsers = await Promise.all(users.map(async (u) => {
        const isAlreadyHashed = typeof u.password === 'string' && /^\$2[aby]\$\d+\$.{53}$/.test(u.password);
        if (u.password && typeof u.password === 'string' && !isAlreadyHashed) {
          const salt = await bcrypt.genSalt(10);
          u.password = await bcrypt.hash(u.password, salt);
        }
        return u;
      }));

      // Use USER_WRITE_COLUMNS to preserve passwords during import
      const sanitizedUsers = sanitizeData(processedUsers, USER_WRITE_COLUMNS);
      if (sanitizedUsers.length > 0) {
        const { error: userError } = await client.from('users').upsert(sanitizedUsers, { onConflict: 'id' });
        if (userError) {
          console.error("Import users error:", JSON.stringify(userError));
          return res.status(500).json({ success: false, message: "Lỗi khi lưu danh sách người dùng", error: userError });
        }
      }
    }
    
    // 2. Upsert other data in parallel
    const tasks = [];
    
    if (loans && Array.isArray(loans) && loans.length > 0) {
      const sanitizedLoans = sanitizeData(loans, LOAN_COLUMNS);
      if (sanitizedLoans.length > 0) {
        tasks.push(client.from('loans').upsert(sanitizedLoans, { onConflict: 'id' }));
      }
    }
    
    if (notifications && Array.isArray(notifications) && notifications.length > 0) {
      const sanitizedNotifications = sanitizeData(notifications, NOTIFICATION_COLUMNS);
      if (sanitizedNotifications.length > 0) {
        tasks.push(client.from('notifications').upsert(sanitizedNotifications, { onConflict: 'id' }));
      }
    }
    
    if (budget !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'SYSTEM_BUDGET', value: budget }, { onConflict: 'key' }));
    }
    
    if (rankProfit !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'TOTAL_RANK_PROFIT', value: rankProfit }, { onConflict: 'key' }));
    }
 
    if (loanProfit !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'TOTAL_LOAN_PROFIT', value: loanProfit }, { onConflict: 'key' }));
    }
 
    if (monthlyStats !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'MONTHLY_STATS', value: monthlyStats }, { onConflict: 'key' }));
    }
    
    if (tasks.length > 0) {
      const results = await Promise.all(tasks);
      const errors = results.filter(r => r.error).map(r => r.error);
      
      if (errors.length > 0) {
        console.error("Import secondary data errors:", JSON.stringify(errors));
        return res.status(500).json({ success: false, message: "Lỗi khi lưu dữ liệu phụ trợ", errors });
      }
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/import:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// Specific health check for Vercel deployment verification
router.get("/api-health", (req, res) => {
  const client = initSupabase();
  res.json({ 
    status: "ok", 
    environment: process.env.NODE_ENV || 'production', 
    supabase: !!client,
    payos: !!process.env.PAYOS_API_KEY,
    timestamp: new Date().toISOString(),
    url: req.url,
    method: req.method
  });
});

// --- PAYOS PAYMENT ROUTES ---

// Create Payment Link
router.post("/payment/create-link", async (req, res) => {
  try {
    const { type, id, amount, description, targetRank, screen, settleType, partialAmount } = req.body; // type: 'SETTLE' | 'UPGRADE', id: loanId or userId
    
    if (!id || !amount) {
      return res.status(400).json({ error: "Thiếu thông tin hoặc số tiền" });
    }

    const client = initSupabase();
    
    const settings = await getMergedSettings(client);
    const payosInstance = getPayOS(settings);

    const orderCode = Date.now();
    const domain = settings.APP_URL || `http://localhost:3000`;
    const expireAt = Date.now() + 15 * 60 * 1000; // 15 mins
    
    let finalDescription = description;
    if (!finalDescription) {
      const masterConfigs = Array.isArray(settings?.MASTER_CONFIGS) ? settings.MASTER_CONFIGS : [];
      
      if (type === 'UPGRADE') {
        const masterUpgrade = masterConfigs.find((c: any) => c.systemMeaning === 'transfer_upgrade');
        const template = masterUpgrade?.format || "HANG {RANK} {USER}";
        
        const rankNames: Record<string, string> = {
          'standard': 'TIEU CHUAN',
          'bronze': 'DONG',
          'silver': 'BAC',
          'gold': 'VANG',
          'diamond': 'KIM CUONG'
        };
        const rankName = rankNames[targetRank || ''] || targetRank || '';
        
        // Fetch user to get phone number
        const { data: userData } = await client.from('users').select('phone').eq('id', id).single();
        const userPhone = userData?.phone || '';

        finalDescription = resolveMasterConfigServer(template, settings, {
          userId: id,
          phone: userPhone,
          rank: rankName,
          abbr: masterUpgrade?.abbreviation || 'NH'
        });
      } else {
        let template = "";
        let loanData: any = null;
        let currentAbbr = "";
        
        if (settleType === 'PARTIAL' || settleType === 'PRINCIPAL') {
          // Fetch loan to get counts and originalBaseId
          const { data } = await client.from('loans').select('extensionCount, partialPaymentCount, originalBaseId, userId, users(phone)').eq('id', id).single();
          loanData = data;
          
          if (settleType === 'PARTIAL') {
            const masterPartial = masterConfigs.find((c: any) => c.systemMeaning === 'transfer_partial');
            template = masterPartial?.format || "TTMP {ID} LAN {SLTTMP}";
            currentAbbr = masterPartial?.abbreviation || 'TTMP';
          } else {
            const masterExtension = masterConfigs.find((c: any) => c.systemMeaning === 'transfer_extension');
            template = masterExtension?.format || "GIA HAN {ID} LAN {SLGH}";
            currentAbbr = masterExtension?.abbreviation || 'GH';
          }
        } else {
          // Fetch loan for full settlement to get user info and originalBaseId
          const { data } = await client.from('loans').select('userId, originalBaseId, users(phone)').eq('id', id).single();
          loanData = data;
          const masterFull = masterConfigs.find((c: any) => c.systemMeaning === 'transfer_full');
          template = masterFull?.format || "TAT TOAN {ID}";
          currentAbbr = masterFull?.abbreviation || 'TT';
        }
        
        const userPhone = loanData?.users?.phone || loanData?.userPhone || '';
        let partialCount = loanData?.partialPaymentCount || 0;
        const extensionCount = loanData?.extensionCount || 0;

        // Fallback: try to extract partial count from ID if it's 0 and the ID looks like it has one
        if (partialCount === 0 && id.toLowerCase().includes('ttmp')) {
          const match = id.match(/(?:LAN|LẦN|L|#)\s*(\d+)$/i);
          if (match) partialCount = parseInt(match[1]);
        }
        
        // Use originalBaseId if available, otherwise strip prefixes from current ID
        let baseId = loanData?.originalBaseId || '';
        if (!baseId) {
          const cleanId = id;
          const allAbbrs = masterConfigs
            .filter((c: any) => c.category === 'ABBREVIATION' || c.category === 'TRANSFER_CONTENT' || c.category === 'CONTRACT_NEW')
            .map((c: any) => c.abbreviation)
            .filter(Boolean);
          const systemAbbrs = ['TTMP', 'GH', 'GN', 'NH', 'TT', 'TATTOAN', 'GIAHAN', 'GIAINGAN'];
          const combinedAbbrs = [...new Set([...allAbbrs, ...systemAbbrs])];
          const stripRegex = new RegExp(`^(${combinedAbbrs.join('|')})`, 'i');
          
          const oldId = cleanId;
          baseId = cleanId.replace(stripRegex, '').trim();
          if (oldId !== baseId) {
            baseId = baseId.replace(/(LAN|LẦN|L|#)\s*\d+$/i, '').replace(/\d+$/, '').trim();
          }
        }

        finalDescription = resolveMasterConfigServer(template, settings, {
          userId: loanData?.userId || '',
          originalId: baseId || id,
          fullId: id,
          sequence: settleType === 'PARTIAL' ? (partialCount + 1) : (extensionCount + 1),
          n: settleType === 'PARTIAL' ? (partialCount + 1) : (extensionCount + 1),
          slgh: extensionCount + 1,
          slttmp: partialCount + 1,
          phone: userPhone,
          rank: '',
          abbr: currentAbbr
        });
      }
    }

    // PayOS strictly limits description to 25 characters. 
    // We must truncate to avoid API errors, but we should do it after all replacements.
    if (finalDescription.length > 25) {
      finalDescription = finalDescription.substring(0, 25);
    }

    const body = {
      orderCode: orderCode,
      amount: Number(amount),
      description: finalDescription,
      cancelUrl: `${domain}/api/payment-result?payment=cancel&type=${type}&id=${id}&screen=${screen || ''}`,
      returnUrl: `${domain}/api/payment-result?payment=success&type=${type}&id=${id}&screen=${screen || ''}`,
    };

    const paymentLinkResponse = await payosInstance.paymentRequests.create(body);
    
    // Save link info to DB
    if (type === 'SETTLE') {
      await client.from('loans').update({ 
        payosCheckoutUrl: paymentLinkResponse.checkoutUrl,
        payosOrderCode: orderCode,
        payosAmount: Number(amount),
        payosExpireAt: expireAt,
        settlementType: settleType || 'ALL',
        partialAmount: partialAmount || null,
        voucherId: req.body.voucherId || null,
        updatedAt: Date.now()
      }).eq('id', id);
    } else if (type === 'UPGRADE') {
      await client.from('users').update({ 
        payosCheckoutUrl: paymentLinkResponse.checkoutUrl,
        payosOrderCode: orderCode,
        payosAmount: Number(amount),
        payosExpireAt: expireAt,
        pendingUpgradeRank: targetRank || null,
        updatedAt: Date.now()
      }).eq('id', id);
    }

    res.json({ 
      success: true, 
      checkoutUrl: paymentLinkResponse.checkoutUrl,
      paymentLinkId: paymentLinkResponse.paymentLinkId,
      orderCode: orderCode
    });
  } catch (e: any) {
    console.error("PayOS Create Link Error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// Cancel Pending Upgrade
router.post("/payment/cancel-upgrade", authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;
    const client = initSupabase();
    
    // Only clear if it was a PayOS attempt (no bill image)
    await client.from('users').update({
      pendingUpgradeRank: null,
      rankUpgradeBill: null,
      payosCheckoutUrl: null,
      payosOrderCode: null,
      updatedAt: Date.now()
    }).eq('id', userId);
    
    res.json({ success: true });
  } catch (e: any) {
    console.error("Cancel Upgrade Error:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// PayOS Webhook
router.post("/payment/webhook", async (req, res) => {
  try {
    console.log("[PAYOS] Webhook received:", JSON.stringify(req.body));
    
    const client = initSupabase();
    const settings = await getMergedSettings(client);
    const payosInstance = getPayOS(settings);

    // Verify the webhook data
    const webhookData = await payosInstance.webhooks.verify(req.body);
    console.log("[PAYOS] Webhook verified data:", JSON.stringify(webhookData));
    
    if (webhookData.code === '00' || webhookData.desc === 'success') {
      // Get current settings for statistics update
      const { data: config } = await client.from('config').select('*');
      const settings: any = {};
      config?.forEach(item => {
        // Ensure numeric values are parsed as numbers for calculation
        if (['SYSTEM_BUDGET', 'TOTAL_LOAN_PROFIT', 'TOTAL_RANK_PROFIT', 'MIN_SYSTEM_BUDGET'].includes(item.key)) {
          settings[item.key] = Number(item.value) || 0;
        } else if (item.key === 'MONTHLY_STATS') {
          try {
            settings[item.key] = typeof item.value === 'string' ? JSON.parse(item.value) : (item.value || []);
          } catch (e) {
            settings[item.key] = [];
          }
        } else {
          settings[item.key] = item.value;
        }
      });

      const orderCode = webhookData.orderCode;
      const amount = webhookData.amount;
      console.log(`[PAYOS] Webhook verified data for orderCode: ${orderCode}, amount: ${amount}`);
      
      // 1. Try to find a loan with this orderCode
      const { data: loan, error: loanError } = await client
        .from('loans')
        .select('*')
        .eq('payosOrderCode', orderCode)
        .maybeSingle();
        
      if (loanError) {
        console.error(`[PAYOS] Error searching for loan with orderCode ${orderCode}:`, JSON.stringify(loanError));
      }
        
      if (loan) {
        console.log(`[PAYOS] Found loan: ${loan.id} for user: ${loan.userId}`);
        const settleType = loan.settlementType || 'ALL';
        const loanId = loan.id;
        
        // Mark current loan as settled
        const { error: updateError } = await client
          .from('loans')
          .update({ 
            status: 'ĐÃ TẤT TOÁN', 
            settledAt: new Date().toISOString(),
            updatedAt: Date.now()
          })
          .eq('id', loanId);
          
        if (updateError) {
          console.error(`[PAYOS] Error updating loan ${loanId} to settled:`, JSON.stringify(updateError));
        } else {
          console.log(`[PAYOS] Loan ${loanId} updated to settled successfully.`);
        }
          
        if (!updateError) {
          const { data: user, error: userError } = await client
            .from('users')
            .select('*')
            .eq('id', loan.userId)
            .single();
            
          if (user && !userError) {
            // Calculate profit and budget updates
            let profitAmount = 0;
            let budgetUpdate = 0;
            const feePercent = Number(settings.PRE_DISBURSEMENT_FEE || 0) / 100;
            const fine = loan.fine || 0;

            // Handle voucher usage
            let voucherDiscount = 0;
            let updatedVouchers = user.vouchers || [];
            if (loan.voucherId && updatedVouchers.length > 0) {
              const vIdx = updatedVouchers.findIndex((v: any) => v.id === loan.voucherId);
              if (vIdx !== -1 && !updatedVouchers[vIdx].isUsed) {
                voucherDiscount = updatedVouchers[vIdx].amount;
                updatedVouchers[vIdx].isUsed = true;
                updatedVouchers[vIdx].usedAt = new Date().toISOString();
              }
            }

            if (settleType === 'PRINCIPAL') {
              profitAmount = (loan.amount * feePercent) + fine;
              budgetUpdate = profitAmount;
            } else if (settleType === 'PARTIAL') {
              const pAmount = loan.partialAmount || 0;
              const remainingPrincipal = loan.amount - pAmount;
              profitAmount = (remainingPrincipal * feePercent) + fine;
              budgetUpdate = pAmount + profitAmount;
            } else {
              profitAmount = fine;
              budgetUpdate = Math.max(0, (loan.amount + fine) - voucherDiscount);
            }

            // Update system stats
            const newBudget = (Number(settings.SYSTEM_BUDGET) || 0) + budgetUpdate;
            const newLoanProfit = (Number(settings.TOTAL_LOAN_PROFIT) || 0) + profitAmount;
            
            let newMonthlyStats = Array.isArray(settings.MONTHLY_STATS) ? [...settings.MONTHLY_STATS] : [];
            const now = new Date();
            const monthKey = `${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
            const existingIdx = newMonthlyStats.findIndex((s: any) => s.month === monthKey);
            
            if (existingIdx !== -1) {
              const stat = { ...newMonthlyStats[existingIdx] };
              stat.loanProfit = (Number(stat.loanProfit) || 0) + profitAmount;
              stat.totalProfit = (Number(stat.rankProfit) || 0) + (Number(stat.loanProfit) || 0);
              newMonthlyStats[existingIdx] = stat;
            } else {
              newMonthlyStats = [{ month: monthKey, rankProfit: 0, loanProfit: profitAmount, totalProfit: profitAmount }, ...newMonthlyStats].slice(0, 6);
            }

            await client.from('config').upsert([
              { key: 'SYSTEM_BUDGET', value: newBudget.toString() },
              { key: 'TOTAL_LOAN_PROFIT', value: newLoanProfit.toString() },
              { key: 'MONTHLY_STATS', value: JSON.stringify(newMonthlyStats) }
            ], { onConflict: 'key' });

            // Handle different settlement types
            if (settleType === 'ALL') {
              // Full Settlement: Restore balance
              const maxOnTimePayments = Number(settings.MAX_ON_TIME_PAYMENTS_FOR_UPGRADE || 10);
              const newBalance = Math.min(user.totalLimit, (user.balance || 0) + loan.amount);
              const newRankProgress = Math.min(maxOnTimePayments, (user.rankProgress || 0) + 1);
              const newFullSettlementCount = (user.fullSettlementCount || 0) + 1;
              
              // Award lucky spin if on time AND meets the required payments count
              let newSpins = user.spins || 0;
              const dueDateParts = (loan.date || "").split('/');
              if (dueDateParts.length === 3) {
                const dueDate = new Date(parseInt(dueDateParts[2]), parseInt(dueDateParts[1]) - 1, parseInt(dueDateParts[0]));
                dueDate.setHours(23, 59, 59, 999);
                
                // Only award if on time
                if (new Date() <= dueDate) {
                  const requiredPayments = Number(settings.LUCKY_SPIN_PAYMENTS_REQUIRED || 1);
                  if (newFullSettlementCount % requiredPayments === 0) {
                    newSpins += 1;
                  }
                }
              }

              const newTotalProfit = (user.totalProfit || 0) + profitAmount;

              await client
                .from('users')
                .update({ 
                  balance: newBalance, 
                  rankProgress: newRankProgress, 
                  fullSettlementCount: newFullSettlementCount,
                  spins: newSpins,
                  vouchers: updatedVouchers,
                  totalProfit: newTotalProfit,
                  updatedAt: Date.now() 
                })
                .eq('id', loan.userId);
            } else {
              // PRINCIPAL (Gia hạn) or PARTIAL (TTMP): Update total profit
              const newTotalProfit = (user.totalProfit || 0) + profitAmount;
              await client
                .from('users')
                .update({ 
                  vouchers: updatedVouchers,
                  totalProfit: newTotalProfit,
                  updatedAt: Date.now() 
                })
                .eq('id', loan.userId);

            // PRINCIPAL (Gia hạn) or PARTIAL (TTMP): Create next cycle loan
            const nextCount = (loan.principalPaymentCount || 0) + 1;
            const nextExtensionCount = settleType === 'PRINCIPAL' ? (loan.extensionCount || 0) + 1 : (loan.extensionCount || 0);
            const nextPartialCount = settleType === 'PARTIAL' ? (loan.partialPaymentCount || 0) + 1 : (loan.partialPaymentCount || 0);
            
            // Generate new ID using Admin configured formats
            const format = settleType === 'PRINCIPAL' 
              ? getFormatFromSettings(settings, 'EXTENSION', settings.CONTRACT_FORMAT_EXTENSION || "{ID}GH{N}", 'SYSTEM_CONTRACT_FORMATS_CONFIG')
              : getFormatFromSettings(settings, 'PARTIAL_SETTLEMENT', settings.CONTRACT_FORMAT_PARTIAL_SETTLEMENT || "{ID}TTMP{N}", 'SYSTEM_CONTRACT_FORMATS_CONFIG');
            
            const newId = generateContractIdServer(loan.userId, format, settings, loan.id, undefined, nextCount, nextExtensionCount, nextPartialCount);
            
            // Calculate new due date (1st of next month)
            let newDueDate = loan.date;
            if (loan.date && typeof loan.date === 'string') {
              const [d, m, y] = loan.date.split('/').map(Number);
              const currentDueDate = new Date(y, m - 1, d);
              const nextCycleDate = new Date(currentDueDate.getFullYear(), currentDueDate.getMonth() + 1, 1);
              const dayStr = nextCycleDate.getDate().toString().padStart(2, '0');
              const monthStr = (nextCycleDate.getMonth() + 1).toString().padStart(2, '0');
              newDueDate = `${dayStr}/${monthStr}/${nextCycleDate.getFullYear()}`;
            }
            
            const nextLoanAmount = settleType === 'PARTIAL' ? (loan.amount - (loan.partialAmount || 0)) : loan.amount;
            
            const nextLoan = {
              ...loan,
              id: newId,
              status: 'ĐANG NỢ',
              date: newDueDate,
              amount: nextLoanAmount,
              principalPaymentCount: nextCount,
              extensionCount: nextExtensionCount,
              partialPaymentCount: nextPartialCount,
              billImage: null,
              settlementType: null,
              partialAmount: null,
              fine: 0,
              payosOrderCode: null,
              payosCheckoutUrl: null,
              payosExpireAt: null,
              updatedAt: Date.now()
            };
              
              await client.from('loans').insert([nextLoan]);
              
              // Update user rank progress and balance if partial
              let newBalance = user.balance;
              if (settleType === 'PARTIAL') {
                newBalance = Math.min(user.totalLimit, (user.balance || 0) + (loan.partialAmount || 0));
              }
              const maxOnTimePayments = Number(settings.MAX_ON_TIME_PAYMENTS_FOR_UPGRADE || 10);
              const newRankProgress = Math.min(maxOnTimePayments, (user.rankProgress || 0) + 1);
              await client
                .from('users')
                .update({ balance: newBalance, rankProgress: newRankProgress, updatedAt: Date.now() })
                .eq('id', loan.userId);
            }
            
            const io = req.app.get("io");
            if (io) {
              io.to(`user_${loan.userId}`).emit("payment_success", { 
                loanId, 
                amount, 
                message: `Khoản vay của bạn đã được ${settleType === 'ALL' ? 'tất toán' : (settleType === 'PARTIAL' ? 'thanh toán một phần' : 'gia hạn')} tự động!` 
              });
              io.to("admin").emit("admin_notification", {
                type: "PAYMENT",
                message: `Người dùng ${loan.userId} đã ${settleType === 'ALL' ? 'tất toán' : (settleType === 'PARTIAL' ? 'TTMP' : 'gia hạn')} khoản vay ${loanId} qua PayOS.`
              });
            }

            // Add persistent notification
            const notifId = `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            await client.from('notifications').insert([{
              id: notifId,
              userId: loan.userId,
              title: 'Thanh toán thành công',
              message: `Khoản vay ${loanId} của bạn đã được ${settleType === 'ALL' ? 'tất toán' : (settleType === 'PARTIAL' ? 'thanh toán một phần' : 'gia hạn')} tự động!`,
              time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date().toLocaleDateString('vi-VN'),
              read: false,
              type: 'LOAN'
            }]);
          }
        }
      } 
      // 2. If not a loan, try to find a user with this orderCode (Rank Upgrade)
      else {
        console.log(`[PAYOS] No loan found for orderCode ${orderCode}, searching for user upgrade...`);
        const { data: user, error: userError } = await client
          .from('users')
          .select('*')
          .eq('payosOrderCode', orderCode)
          .maybeSingle();
          
        if (userError) {
          console.error(`[PAYOS] Error searching for user with orderCode ${orderCode}:`, JSON.stringify(userError));
        }
          
        if (user && !userError) {
          console.log(`[PAYOS] Found user: ${user.id} for rank upgrade to: ${user.pendingUpgradeRank}`);
          // Process Rank Upgrade
          const targetRank = user.pendingUpgradeRank;
          if (targetRank) {
            const rankLimits: Record<string, number> = {
              'standard': 2000000,
              'bronze': 3000000,
              'silver': 4000000,
              'gold': 5000000,
              'diamond': 10000000
            };
            
            const newLimit = rankLimits[targetRank] || user.totalLimit;
            const limitDiff = newLimit - user.totalLimit;
            const newBalance = (user.balance || 0) + limitDiff;
            const upgradeFee = Math.round(newLimit * (settings.UPGRADE_PERCENT / 100));

            await client
              .from('users')
              .update({ 
                rank: targetRank, 
                totalLimit: newLimit,
                balance: newBalance,
                pendingUpgradeRank: null,
                rankUpgradeBill: 'PAYOS_SUCCESS',
                updatedAt: Date.now()
              })
              .eq('id', user.id);

            // Update system stats
            const newBudget = (Number(settings.SYSTEM_BUDGET) || 0) + upgradeFee;
            const newRankProfit = (Number(settings.TOTAL_RANK_PROFIT) || 0) + upgradeFee;
            
            let newMonthlyStats = Array.isArray(settings.MONTHLY_STATS) ? [...settings.MONTHLY_STATS] : [];
            const now = new Date();
            const monthKey = `${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
            const existingIdx = newMonthlyStats.findIndex((s: any) => s.month === monthKey);
            
            if (existingIdx !== -1) {
              const stat = { ...newMonthlyStats[existingIdx] };
              stat.rankProfit = (Number(stat.rankProfit) || 0) + upgradeFee;
              stat.totalProfit = (Number(stat.rankProfit) || 0) + (Number(stat.loanProfit) || 0);
              newMonthlyStats[existingIdx] = stat;
            } else {
              newMonthlyStats = [{ month: monthKey, rankProfit: upgradeFee, loanProfit: 0, totalProfit: upgradeFee }, ...newMonthlyStats].slice(0, 6);
            }

            await client.from('config').upsert([
              { key: 'SYSTEM_BUDGET', value: newBudget.toString() },
              { key: 'TOTAL_RANK_PROFIT', value: newRankProfit.toString() },
              { key: 'MONTHLY_STATS', value: JSON.stringify(newMonthlyStats) }
            ], { onConflict: 'key' });
              
            const io = req.app.get("io");
            if (io) {
              io.to(`user_${user.id}`).emit("payment_success", { 
                type: 'UPGRADE',
                message: `Chúc mừng! Bạn đã được nâng hạng lên ${targetRank.toUpperCase()} thành công!` 
              });
              io.to(`user_${user.id}`).emit("rank_upgrade_success", { 
                rank: targetRank, 
                message: `Chúc mừng! Bạn đã được nâng hạng lên ${targetRank.toUpperCase()} thành công!` 
              });
              io.to("admin").emit("admin_notification", {
                type: "RANK_UPGRADE",
                message: `Người dùng ${user.id} đã nâng hạng lên ${targetRank.toUpperCase()} qua PayOS.`
              });
            }

            // Add persistent notification
            const notifId = `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            await client.from('notifications').insert([{
              id: notifId,
              userId: user.id,
              title: 'Nâng hạng thành công',
              message: `Chúc mừng! Bạn đã được nâng hạng lên ${targetRank.toUpperCase()} thành công qua PayOS!`,
              time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date().toLocaleDateString('vi-VN'),
              read: false,
              type: 'RANK'
            }]);
          }
        }
      }
    }
    
    res.json({ status: "ok" });
  } catch (e: any) {
    console.error("PayOS Webhook Error:", e);
    res.json({ status: "error", message: e.message });
  }
});

router.get("/payment-result", (req, res) => {
  const { payment, type, id, screen } = req.query;
  res.send(`
    <html>
      <head>
        <title>Kết quả thanh toán</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            height: 100vh; 
            background: #000; 
            color: #fff; 
            margin: 0;
            text-align: center;
          }
          .loader { 
            border: 4px solid #1a1a1a; 
            border-top: 4px solid #ff8c00; 
            border-radius: 50%; 
            width: 50px; 
            height: 50px; 
            animation: spin 1s linear infinite; 
            margin-bottom: 24px; 
            box-shadow: 0 0 20px rgba(255, 140, 0, 0.2);
          }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          h1 { font-size: 18px; font-weight: 900; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 8px 0; }
          p { font-size: 12px; color: #888; margin: 0; }
        </style>
      </head>
      <body>
        <div class="loader"></div>
        <h1>Đang xử lý</h1>
        <p>Hệ thống đang đồng bộ kết quả thanh toán...</p>
        <script>
          // Notify the opener if it exists
          try {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage({ 
                type: 'PAYOS_PAYMENT_RESULT', 
                payment: '${payment}', 
                paymentType: '${type}', 
                id: '${id}', 
                screen: '${screen}' 
              }, '*');
              
              // Give it a moment to process before closing
              setTimeout(() => {
                window.close();
              }, 500);
            } else {
              // If no opener, redirect to dashboard
              window.location.href = '/dashboard?payment=${payment}&type=${type}&id=${id}&screen=${screen}';
            }
          } catch (e) {
            console.error('Error notifying opener:', e);
            window.location.href = '/dashboard?payment=${payment}&type=${type}&id=${id}&screen=${screen}';
          }
        </script>
      </body>
    </html>
  `);
});

// Export the router
export { router as apiRouter };
export default app;
