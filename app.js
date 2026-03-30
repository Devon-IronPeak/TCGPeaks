/* ═══════════════════════════════════════════════════════
   TCG Peaks — app.js
   All application logic, data, state, rendering
═══════════════════════════════════════════════════════ */

/* ══ CONFIG ══ */
const CONFIG = {
  justTcg: { apiKey: '', baseUrl: 'https://api.justtcg.com/v1', connected: false }
};

/* ══ EBAY SLAB PRICING API ══ */
const EbaySlabAPI = (() => {
  const CACHE_KEY_PREFIX = 'tcgp_ebay_slab_';
  const CACHE_TTL = 3_600_000; // 1 hour cache

  // Weighted price calculation with exponential decay (half-life 30 days)
  function calculateWeightedPrice(sales, halfLifeDays = 30) {
    if (!sales || sales.length === 0) return 0;
    const now = new Date();
    let totalWeightedValue = 0;
    let totalWeight = 0;
    sales.forEach(sale => {
      const saleDate = new Date(sale.saleDate);
      const daysAgo = Math.max(0, (now - saleDate) / (1000 * 60 * 60 * 24));
      const weight = Math.pow(0.5, daysAgo / halfLifeDays);
      const truePrice = parseFloat(sale.salePrice) + parseFloat(sale.shippingCost || 0);
      totalWeightedValue += truePrice * weight;
      totalWeight += weight;
    });
    if (totalWeight === 0) return 0;
    return Math.round((totalWeightedValue / totalWeight) * 100) / 100;
  }

  // Determine best timeframe based on volume
  function getMarketValue(allSales) {
    const now = new Date();
    const msPerDay = 1000 * 60 * 60 * 24;
    const sales90  = allSales.filter(s => (now - new Date(s.saleDate)) / msPerDay <= 90);
    const sales180 = allSales.filter(s => (now - new Date(s.saleDate)) / msPerDay <= 180);
    let finalPrice, confidence;
    if (sales90.length >= 10) {
      finalPrice = calculateWeightedPrice(sales90, 30);
      confidence = 'High (90-Day)';
    } else if (sales180.length >= 10) {
      finalPrice = calculateWeightedPrice(sales180, 45);
      confidence = 'Medium (180-Day)';
    } else if (allSales.length > 0) {
      finalPrice = calculateWeightedPrice(allSales, 60);
      confidence = allSales.length < 5 ? 'Very Low (Sparse)' : 'Low (365-Day)';
    } else {
      return { price: null, confidence: 'No Data', dataPointsUsed: 0 };
    }
    return { price: finalPrice, confidence, dataPointsUsed: allSales.length };
  }

  // Generate realistic simulated eBay sale history for a slab
  function generateSlabSales(card, daysBack = 365) {
    const seed = (card.id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    let lcg = (seed * 1664525 + 1013904223) & 0xffffffff;
    const rand = () => { lcg = (lcg * 1664525 + 1013904223) & 0xffffffff; return (lcg >>> 0) / 0xffffffff; };

    const market = card.market;
    const volatility = market > 1000 ? 0.06 : market > 100 ? 0.10 : 0.15;
    const sales = [];
    // Volume: popular slabs sell more frequently
    const avgSalesPerMonth = market > 500 ? 3 : market > 100 ? 6 : 10;
    const totalSales = Math.round(avgSalesPerMonth * (daysBack / 30) * (0.6 + rand() * 0.8));

    for (let i = 0; i < totalSales; i++) {
      const daysAgo = rand() * daysBack;
      const saleDate = new Date(Date.now() - daysAgo * 86400000);
      // Older sales drift from current price
      const ageFactor = 1 + (daysAgo / daysBack) * (rand() > 0.5 ? 0.2 : -0.1);
      const noise = 1 + (rand() - 0.5) * volatility * 2;
      const salePrice = Math.max(market * 0.5, market * ageFactor * noise);
      const shippingCost = rand() > 0.6 ? 0 : 4 + rand() * 10;
      sales.push({
        ebayItemId: `${seed}${Math.round(rand()*1e10)}`,
        cardName: card.name,
        gradingCompany: card.grader,
        grade: card.grade,
        salePrice: Math.round(salePrice * 100) / 100,
        shippingCost: Math.round(shippingCost * 100) / 100,
        currency: 'USD',
        saleDate: saleDate.toISOString(),
        listingType: rand() > 0.4 ? 'FixedPrice' : 'Auction',
      });
    }
    return sales.sort((a, b) => new Date(b.saleDate) - new Date(a.saleDate));
  }

  // Fetch (or simulate) slab sale history
  async function fetchSlabHistory(card) {
    if (card.cat !== 'slab') return null;
    const cacheKey = CACHE_KEY_PREFIX + card.id;
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached && (Date.now() - cached.ts) < CACHE_TTL) return cached.data;
    } catch {}

    // In production this would be: await fetch(`/api/slab-price?card=...&grader=${card.grader}&grade=${card.grade}`)
    // For now, generate realistic simulated data based on the card's known market price
    const sales = generateSlabSales(card, 365);
    const result = { sales, marketValue: getMarketValue(sales) };

    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: result })); } catch {}
    return result;
  }

  // Get price history timeseries for charting
  function getSlabPriceTimeseries(sales, days) {
    const now = Date.now();
    const cutoff = now - days * 86400000;
    const filtered = sales.filter(s => new Date(s.saleDate).getTime() >= cutoff);
    // Bucket into daily/weekly points
    const bucketSize = days <= 30 ? 1 : days <= 90 ? 3 : days <= 365 ? 7 : 30;
    const buckets = {};
    filtered.forEach(s => {
      const t = new Date(s.saleDate).getTime();
      const bucketKey = Math.floor((now - t) / (bucketSize * 86400000));
      if (!buckets[bucketKey]) buckets[bucketKey] = [];
      buckets[bucketKey].push(parseFloat(s.salePrice) + parseFloat(s.shippingCost || 0));
    });
    const points = [];
    for (let b = Object.keys(buckets).length; b >= 0; b--) {
      if (buckets[b]) {
        const avg = buckets[b].reduce((a, v) => a + v, 0) / buckets[b].length;
        const d = new Date(now - (b * bucketSize * 86400000));
        points.push({ date: d, price: Math.round(avg * 100) / 100, volume: buckets[b].length });
      }
    }
    return points;
  }

  return { fetchSlabHistory, getSlabPriceTimeseries, getMarketValue, generateSlabSales };
})();

/* ══ DEMO DATA — EXPANDED WITH JAPANESE CARDS ══ */
const DEMO_FOLDERS = [
  {id:'f1',name:'SV Promos & Specials',      game:'pokemon',  enabled:true,  premiumPct:10, premiumFlat:0},
  {id:'f2',name:'Vintage Holos (Base–Neo)',  game:'pokemon',  enabled:true,  premiumPct:0,  premiumFlat:5},
  {id:'f3',name:'Graded Hits — English',     game:'pokemon',  enabled:true,  premiumPct:15, premiumFlat:0},
  {id:'f4',name:'Sealed Products',           game:'pokemon',  enabled:true,  premiumPct:5,  premiumFlat:0},
  {id:'f5',name:'OP01 Romance Dawn',         game:'onepiece', enabled:true,  premiumPct:8,  premiumFlat:0},
  {id:'f6',name:'OP06–OP10 Singles',         game:'onepiece', enabled:true,  premiumPct:5,  premiumFlat:0},
  {id:'f7',name:'One Piece Graded',          game:'onepiece', enabled:true,  premiumPct:12, premiumFlat:0},
  {id:'f8',name:'Japanese Cards & Slabs',    game:'pokemon',  enabled:true,  premiumPct:8,  premiumFlat:0},
  {id:'f9',name:'Archived',                  game:'pokemon',  enabled:false, premiumPct:0,  premiumFlat:0},
];

const DEMO_CARDS = [
  // ── Pokémon · SV Promos & Specials (f1) ──
  {id:'p1',  name:'Charizard ex',               set:'Obsidian Flames',     game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:18,    paid:55,    qty:1, folder:'f1', num:'125/197'},
  {id:'p2',  name:'Miraidon ex',                set:'Scarlet & Violet',    game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:7,     paid:22,    qty:2, folder:'f1', num:'081/198'},
  {id:'p3',  name:'Mewtwo VSTAR',               set:'Pokémon GO',          game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:10,    paid:18,    qty:1, folder:'f1', num:'031/078'},
  {id:'p4a', name:'Iono',                       set:'Paldea Evolved',      game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:16,    paid:20,    qty:2, folder:'f1', num:'185/193'},
  {id:'p4b', name:'Lugia V',                    set:'Silver Tempest',      game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:9,     paid:14,    qty:2, folder:'f1', num:'138/195'},
  {id:'p4c', name:'Gardevoir ex SAR',           set:'Scarlet & Violet',    game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:28,    paid:30,    qty:1, folder:'f1', num:'208/198'},
  {id:'p4d', name:'Arcanine ex',                set:'Obsidian Flames',     game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:7,     paid:10,    qty:3, folder:'f1', num:'219/197'},
  {id:'p4e', name:'Pidgeot ex',                 set:'Obsidian Flames',     game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:6,     paid:8,     qty:2, folder:'f1', num:'164/197'},

  // ── Pokémon · Vintage Holos (f2) ──
  {id:'p5',  name:'Pikachu ex',                 set:'151',                 game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:14,    paid:25,    qty:3, folder:'f2', num:'025/165'},
  {id:'p6',  name:'Blastoise ex',               set:'151',                 game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:8,     paid:14,    qty:2, folder:'f2', num:'009/165'},
  {id:'p6a', name:'Venusaur ex',                set:'151',                 game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:9,     paid:14,    qty:1, folder:'f2', num:'003/165'},
  {id:'p6b', name:'Charizard ex',               set:'151',                 game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:28,    paid:40,    qty:1, folder:'f2', num:'006/165'},
  {id:'p6c', name:'Mewtwo ex',                  set:'151',                 game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:12,    paid:18,    qty:2, folder:'f2', num:'150/165'},
  {id:'p6d', name:'Mew ex',                     set:'151',                 game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:38,    paid:45,    qty:1, folder:'f2', num:'151/165'},

  // ── Pokémon · Sealed (f4) ──
  {id:'p7',  name:'Obsidian Flames Booster Box',set:'Obsidian Flames',     game:'pokemon',  cat:'sealed', grader:null,  grade:null, market:90,    paid:95,    qty:2, folder:'f4', num:null},
  {id:'p8',  name:'151 Elite Trainer Box',      set:'151',                 game:'pokemon',  cat:'sealed', grader:null,  grade:null, market:60,    paid:55,    qty:5, folder:'f4', num:null},
  {id:'p9',  name:'Paldean Fates ETB',          set:'Paldean Fates',       game:'pokemon',  cat:'sealed', grader:null,  grade:null, market:50,    paid:45,    qty:3, folder:'f4', num:null},
  {id:'p9a', name:'Twilight Masquerade ETB',    set:'Twilight Masquerade', game:'pokemon',  cat:'sealed', grader:null,  grade:null, market:48,    paid:42,    qty:2, folder:'f4', num:null},
  {id:'p9b', name:'Surging Sparks Booster Box', set:'Surging Sparks',      game:'pokemon',  cat:'sealed', grader:null,  grade:null, market:130,   paid:110,   qty:2, folder:'f4', num:null},
  {id:'p9c', name:'Stellar Crown ETB',          set:'Stellar Crown',       game:'pokemon',  cat:'sealed', grader:null,  grade:null, market:44,    paid:40,    qty:3, folder:'f4', num:null},

  // ── Pokémon · Graded Hits English (f3) ──
  {id:'p10', name:'Charizard Holo 1st Edition', set:'Base Set',            game:'pokemon',  cat:'slab',   grader:'PSA', grade:9,    market:10200, paid:7200,  qty:1, folder:'f3', num:'4/102'},
  {id:'p11', name:'Mewtwo Holo',                set:'Base Set',            game:'pokemon',  cat:'slab',   grader:'PSA', grade:8,    market:480,   paid:420,   qty:1, folder:'f3', num:'10/102'},
  {id:'p12', name:'Charizard ex SIR',           set:'Obsidian Flames',     game:'pokemon',  cat:'slab',   grader:'CGC', grade:10,   market:380,   paid:310,   qty:1, folder:'f3', num:'228/197'},
  {id:'p13', name:'Miraidon ex SIR',            set:'Scarlet & Violet',    game:'pokemon',  cat:'slab',   grader:'CGC', grade:9.5,  market:75,    paid:130,   qty:1, folder:'f3', num:'245/198'},
  {id:'p14', name:'Umbreon VMAX Alt Art',       set:'Evolving Skies',      game:'pokemon',  cat:'slab',   grader:'BGS', grade:9,    market:1650,  paid:1200,  qty:1, folder:'f3', num:'215/203'},
  {id:'p15', name:'Rayquaza VMAX Alt Art',      set:'Evolving Skies',      game:'pokemon',  cat:'slab',   grader:'BGS', grade:9.5,  market:420,   paid:350,   qty:1, folder:'f3', num:'218/203'},
  {id:'p15a',name:'Iono SAR',                   set:'Paldea Evolved',      game:'pokemon',  cat:'slab',   grader:'PSA', grade:10,   market:280,   paid:220,   qty:1, folder:'f3', num:'249/193'},
  {id:'p15b',name:'Gardevoir ex SAR',           set:'Scarlet & Violet',    game:'pokemon',  cat:'slab',   grader:'PSA', grade:10,   market:190,   paid:150,   qty:1, folder:'f3', num:'208/198'},
  {id:'p15c',name:'Pidgeot ex HYP',             set:'Obsidian Flames',     game:'pokemon',  cat:'slab',   grader:'CGC', grade:10,   market:55,    paid:40,    qty:2, folder:'f3', num:'197/197'},
  {id:'p15d',name:'Charizard Holo',             set:'Base Set',            game:'pokemon',  cat:'slab',   grader:'PSA', grade:10,   market:32000, paid:25000, qty:1, folder:'f3', num:'4/102'},
  {id:'p15e',name:'Pikachu Holo',               set:'Base Set',            game:'pokemon',  cat:'slab',   grader:'PSA', grade:8,    market:180,   paid:140,   qty:1, folder:'f3', num:'58/102'},
  {id:'p15f',name:'Lugia Holo',                 set:'Neo Genesis',         game:'pokemon',  cat:'slab',   grader:'PSA', grade:9,    market:1100,  paid:800,   qty:1, folder:'f3', num:'9/111'},

  // Cases
  {id:'p16', name:'Stellar Crown Booster Case', set:'Stellar Crown',       game:'pokemon',  cat:'case',   grader:null,  grade:null, market:440,   paid:400,   qty:1, folder:'f4', num:null},
  {id:'p16a',name:'Surging Sparks Booster Case',set:'Surging Sparks',      game:'pokemon',  cat:'case',   grader:null,  grade:null, market:680,   paid:600,   qty:1, folder:'f4', num:null},

  // ── Pokémon · Japanese Cards & Slabs (f8) ──
  {id:'jp1', name:'Charizard ex SAR (JPN)',     set:'Ruler of the Black Flame',  game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:32,    paid:28,    qty:2, folder:'f8', num:'105/108', lang:'Japanese'},
  {id:'jp2', name:'Umbreon ex SAR (JPN)',       set:'Night Wanderer',            game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:18,    paid:22,    qty:2, folder:'f8', num:'085/064', lang:'Japanese'},
  {id:'jp3', name:'Pikachu ex SAR (JPN)',       set:'Raging Surf',               game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:22,    paid:18,    qty:3, folder:'f8', num:'077/062', lang:'Japanese'},
  {id:'jp4', name:'Gardevoir ex SAR (JPN)',     set:'Clay Burst',                game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:15,    paid:12,    qty:2, folder:'f8', num:'086/071', lang:'Japanese'},
  {id:'jp5', name:'Iono SAR (JPN)',             set:'Snow Hazard / Clay Burst',  game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:20,    paid:16,    qty:3, folder:'f8', num:'075/071', lang:'Japanese'},
  {id:'jp6', name:'Mew ex SAR (JPN)',           set:'Pokémon Card 151',          game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:55,    paid:40,    qty:1, folder:'f8', num:'205/165', lang:'Japanese'},
  {id:'jp7', name:'Charizard ex SAR PSA 10 (JPN)',set:'Ruler of the Black Flame',game:'pokemon',  cat:'slab',   grader:'PSA', grade:10,   market:580,   paid:420,   qty:1, folder:'f8', num:'105/108', lang:'Japanese'},
  {id:'jp8', name:'Pikachu VMAX SAR (JPN)',     set:'Fusion Arts',               game:'pokemon',  cat:'slab',   grader:'CGC', grade:10,   market:320,   paid:250,   qty:1, folder:'f8', num:'TBA',     lang:'Japanese'},
  {id:'jp9', name:'Erika\'s Invitation SAR (JPN)',set:'Obsidian Flames',         game:'pokemon',  cat:'raw',    grader:null,  grade:null, market:14,    paid:10,    qty:4, folder:'f8', num:'096/187', lang:'Japanese'},
  {id:'jp10',name:'Ancient Booster Box (JPN)',  set:'Ancient Roar',              game:'pokemon',  cat:'sealed', grader:null,  grade:null, market:75,    paid:60,    qty:2, folder:'f8', num:null,      lang:'Japanese'},

  // ── One Piece · OP01 Romance Dawn (f5) ──
  {id:'o1',  name:'Monkey D. Luffy',            set:'OP01 Romance Dawn',   game:'onepiece', cat:'raw',    grader:null,  grade:null, market:25,    paid:35,    qty:2, folder:'f5', num:'OP01-060'},
  {id:'o2',  name:'Roronoa Zoro',               set:'OP01 Romance Dawn',   game:'onepiece', cat:'raw',    grader:null,  grade:null, market:16,    paid:22,    qty:1, folder:'f5', num:'OP01-001'},
  {id:'o3',  name:'Nami',                       set:'OP01 Romance Dawn',   game:'onepiece', cat:'raw',    grader:null,  grade:null, market:5,     paid:8,     qty:3, folder:'f5', num:'OP01-002'},
  {id:'o3a', name:'Shanks',                     set:'OP01 Romance Dawn',   game:'onepiece', cat:'raw',    grader:null,  grade:null, market:45,    paid:50,    qty:1, folder:'f5', num:'OP01-120'},
  {id:'o3b', name:'Portgas D. Ace',             set:'OP01 Romance Dawn',   game:'onepiece', cat:'raw',    grader:null,  grade:null, market:30,    paid:32,    qty:2, folder:'f5', num:'OP02-013'},
  {id:'o3c', name:'Sanji',                      set:'OP01 Romance Dawn',   game:'onepiece', cat:'raw',    grader:null,  grade:null, market:8,     paid:10,    qty:2, folder:'f5', num:'OP01-013'},

  // ── One Piece · OP06–OP10 (f6) ──
  {id:'o4',  name:'Yamato',                     set:'OP04 Kingdoms of Intrigue',game:'onepiece',cat:'raw',grader:null,grade:null, market:18,    paid:28,    qty:2, folder:'f6', num:'OP04-110'},
  {id:'o5',  name:'Charlotte Linlin',           set:'OP02 Paramount War',  game:'onepiece', cat:'raw',    grader:null,  grade:null, market:9,     paid:14,    qty:4, folder:'f6', num:'OP02-004'},
  {id:'o5a', name:'Trafalgar Law',              set:'OP05 Awakening of the New Era',game:'onepiece',cat:'raw',grader:null,grade:null,market:22,  paid:25,    qty:2, folder:'f6', num:'OP05-060'},
  {id:'o5b', name:'Monkey D. Luffy',            set:'OP06 Wings of Captain',game:'onepiece', cat:'raw',    grader:null,  grade:null, market:14,    paid:18,    qty:3, folder:'f6', num:'OP06-060'},
  {id:'o5c', name:'Rob Lucci',                  set:'OP06 Wings of Captain',game:'onepiece', cat:'raw',    grader:null,  grade:null, market:9,     paid:12,    qty:2, folder:'f6', num:'OP06-100'},
  {id:'o5d', name:'Eustass Kid',                set:'OP04 Kingdoms of Intrigue',game:'onepiece',cat:'raw',grader:null,grade:null, market:12,    paid:15,    qty:3, folder:'f6', num:'OP04-040'},
  {id:'o5e', name:'Nico Robin',                 set:'OP02 Paramount War',  game:'onepiece', cat:'raw',    grader:null,  grade:null, market:7,     paid:9,     qty:2, folder:'f6', num:'OP02-050'},
  {id:'o5f', name:'Monkey D. Dragon',           set:'OP07 500 Years in the Future',game:'onepiece',cat:'raw',grader:null,grade:null,market:28,  paid:25,    qty:1, folder:'f6', num:'OP07-070'},

  // Sealed One Piece
  {id:'o6',  name:'OP01 Romance Dawn Booster Box',set:'OP01 Romance Dawn', game:'onepiece', cat:'sealed', grader:null,  grade:null, market:175,   paid:160,   qty:2, folder:'f5', num:null},
  {id:'o7',  name:'OP07 Booster Box',            set:'OP07 500 Years in the Future',game:'onepiece',cat:'sealed',grader:null,grade:null,market:90, paid:80,   qty:3, folder:'f6', num:null},
  {id:'o7a', name:'OP04 Booster Box',            set:'OP04 Kingdoms of Intrigue',game:'onepiece',cat:'sealed',grader:null,grade:null,market:140, paid:120,  qty:2, folder:'f6', num:null},
  {id:'o7b', name:'OP05 Booster Box',            set:'OP05 Awakening of the New Era',game:'onepiece',cat:'sealed',grader:null,grade:null,market:95,paid:85,  qty:2, folder:'f6', num:null},

  // ── One Piece · Graded (f7) ──
  {id:'o8',  name:'Monkey D. Luffy',            set:'OP01 Romance Dawn',   game:'onepiece', cat:'slab',   grader:'PSA', grade:10,   market:260,   paid:290,   qty:1, folder:'f7', num:'OP01-060'},
  {id:'o9',  name:'Roronoa Zoro',               set:'OP01 Romance Dawn',   game:'onepiece', cat:'slab',   grader:'CGC', grade:10,   market:180,   paid:195,   qty:1, folder:'f7', num:'OP01-001'},
  {id:'o10', name:'Red-Haired Shanks',          set:'OP04 Kingdoms of Intrigue',game:'onepiece',cat:'slab',grader:'PSA',grade:9,    market:90,    paid:120,   qty:1, folder:'f7', num:'OP04-040'},
  {id:'o11', name:'Boa Hancock',                set:'OP02 Paramount War',  game:'onepiece', cat:'slab',   grader:'BGS', grade:9.5,  market:55,    paid:70,    qty:1, folder:'f7', num:'OP02-100'},
  {id:'o11a',name:'Portgas D. Ace',             set:'OP02 Paramount War',  game:'onepiece', cat:'slab',   grader:'PSA', grade:10,   market:310,   paid:280,   qty:1, folder:'f7', num:'OP02-013'},
  {id:'o11b',name:'Yamato',                     set:'OP04 Kingdoms of Intrigue',game:'onepiece',cat:'slab',grader:'CGC',grade:10,   market:180,   paid:160,   qty:1, folder:'f7', num:'OP04-110'},
  {id:'o11c',name:'Trafalgar Law',              set:'OP05 Awakening of the New Era',game:'onepiece',cat:'slab',grader:'PSA',grade:10,market:220,  paid:190,   qty:1, folder:'f7', num:'OP05-060'},

  // Cases One Piece
  {id:'o12', name:'OP01 Romance Dawn Display Case',set:'OP01 Romance Dawn',game:'onepiece', cat:'case',   grader:null,  grade:null, market:250,   paid:240,   qty:1, folder:'f5', num:null},
  {id:'o12a',name:'OP07 Display Case',           set:'OP07 500 Years in the Future',game:'onepiece',cat:'case',grader:null,grade:null,market:195, paid:180,  qty:1, folder:'f6', num:null},
];

const DEMO_ACCOUNTS = {
  admin:  {name:'TCG Admin',   email:'admin@tcgpeaks.com',  role:'admin'},
  seller: {name:'Peak Seller', email:'seller@tcgpeaks.com', role:'seller'},
  user:   {name:'Card Trainer',email:'user@tcgpeaks.com',   role:'user'},
};
let SIM_USERS = [
  {name:'TCG Admin',   email:'admin@tcgpeaks.com',  role:'admin'},
  {name:'Peak Seller', email:'seller@tcgpeaks.com', role:'seller'},
  {name:'Card Trainer',email:'user@tcgpeaks.com',   role:'user'},
  {name:'Ash K.',      email:'ash@example.com',      role:'user'},
  {name:'Misty W.',    email:'misty@example.com',    role:'seller'},
];
const DEMO_COLLECTION = {
  portfolios:[
    {id:'cp1',name:'My Hits',listed:false},
    {id:'cp2',name:'Watching',listed:false},
  ],
  cards:[
    {id:'cc1',name:'Charizard ex',               set:'Obsidian Flames',  game:'pokemon', cat:'raw',    grader:null, grade:null, market:18,   paid:55,   qty:1, portfolio:'cp1', num:'125/197'},
    {id:'cc2',name:'Umbreon VMAX Alt Art',       set:'Evolving Skies',   game:'pokemon', cat:'slab',   grader:'PSA',grade:9,   market:1650, paid:1200, qty:1, portfolio:'cp1', num:'215/203'},
    {id:'cc3',name:'151 Elite Trainer Box',      set:'151',              game:'pokemon', cat:'sealed', grader:null, grade:null, market:60,   paid:55,   qty:2, portfolio:'cp1', num:null},
    {id:'cc4',name:'Monkey D. Luffy',            set:'OP01 Romance Dawn',game:'onepiece',cat:'raw',    grader:null, grade:null, market:25,   paid:35,   qty:1, portfolio:'cp1', num:'OP01-060'},
    {id:'cc5',name:'Yamato',                     set:'OP04 Kingdoms of Intrigue',game:'onepiece',cat:'raw',grader:null,grade:null,market:18,paid:28,   qty:2, portfolio:'cp1', num:'OP04-110'},
    {id:'cc6',name:'Charizard Holo 1st Edition', set:'Base Set',         game:'pokemon', cat:'slab',   grader:'PSA',grade:8,   market:480,  paid:420,  qty:1, portfolio:'cp2', num:'10/102'},
    {id:'cc7',name:'Pikachu ex',                 set:'151',              game:'pokemon', cat:'raw',    grader:null, grade:null, market:14,   paid:25,   qty:1, portfolio:'cp2', num:'025/165'},
    {id:'cc8',name:'Charizard ex SAR (JPN)',     set:'Ruler of the Black Flame',game:'pokemon',cat:'raw',grader:null,grade:null,market:32,  paid:28,   qty:1, portfolio:'cp2', num:'105/108', lang:'Japanese'},
  ]
};

/* ══ STATE ══ */
const S = {
  user:null, role:null,
  store:{ folders:[], cards:[], global:{pokePct:0,pokeFlat:0,opPct:0,opFlat:0} },
  collection:{ portfolios:[], cards:[], activePortfolioId:null },
  cart:[],
  ui:{
    pokemon: {cat:'all',grader:'all',search:'',sort:'price-desc',folder:''},
    onepiece:{cat:'all',grader:'all',search:'',sort:'price-desc',folder:''},
    sell:{search:'',folder:'',activeTab:'portfolios'},
    adminTab:'pricing', chartRange:30, collView:'collection',
  },
  detailCard:null, priceChart:null,
  pendingAddCard:null, pendingPortfolio:null,
  manualCard:null,
  slabSalesCache: {},
};

/* ══ CARD IMAGE SERVICE — FIXED ══ */
const IMG_CACHE = {};

const CardImages = {
  // Comprehensive set code mapping including Japanese sets
  _POKE_SETS:{
    'Obsidian Flames':'sv3','Scarlet & Violet':'sv1','Pokémon GO':'pgo',
    '151':'sv3pt5','Evolving Skies':'swsh7','Base Set':'base1',
    'Paldean Fates':'sv4pt5','Paradox Rift':'sv4','Temporal Forces':'sv5',
    'Twilight Masquerade':'sv6','Stellar Crown':'sv7','Promos':'swshp',
    'CoroCoro':'swshp','SV Base':'sv1','Paldea Evolved':'sv2',
    'Obsidian Flames':'sv3','Silver Tempest':'swsh12','Lost Origin':'swsh11',
    'Astral Radiance':'swsh10','Brilliant Stars':'swsh9','Fusion Strike':'swsh8',
    'Chilling Reign':'swsh6','Battle Styles':'swsh5','Vivid Voltage':'swsh4',
    'Darkness Ablaze':'swsh3','Rebel Clash':'swsh2','Sword & Shield':'swsh1',
    'Neo Genesis':'neo1','Neo Discovery':'neo2','Neo Revelation':'neo3','Neo Destiny':'neo4',
    'Surging Sparks':'sv8','Prismatic Evolutions':'sv8pt5',
    // Japanese sets — map to nearest English equivalent for API lookup
    'Ruler of the Black Flame':'sv3',
    'Night Wanderer':'sv6pt5',
    'Raging Surf':'sv3a',
    'Clay Burst':'sv2a',
    'Snow Hazard / Clay Burst':'sv2a',
    'Pokémon Card 151':'sv3pt5',
    'Fusion Arts':'swsh8',
    'Ancient Roar':'sv4',
    'Future Flash':'sv4',
  },
  _apiCache:{},

  async get(card) {
    if (IMG_CACHE[card.id]) return IMG_CACHE[card.id];
    if (card.imageUrl) { IMG_CACHE[card.id] = card.imageUrl; return card.imageUrl; }
    let url = null;
    if (card.cat === 'sealed' || card.cat === 'case') {
      url = this._sealed(card);
    } else if (card.game === 'pokemon') {
      url = await this._pokemon(card);
    } else if (card.game === 'onepiece') {
      url = await this._onePiece(card);
    }
    if (url) IMG_CACHE[card.id] = url;
    return url;
  },

  async _pokemon(card) {
    const setCode = this._POKE_SETS[card.set];
    if (!setCode) return null;

    // Strip Japanese language markers and display suffixes from name for API search
    const cleanName = card.name
      .replace(/\s*\(JPN\)\s*/gi, '')
      .replace(/\s+(Alt Art|SAR|Full Art|SIR|HYP|Special Art Rare|Hyper Rare|Secret Rare|Rainbow Rare|Gold)$/i, '')
      .trim();

    const cacheKey = `${setCode}-${cleanName}-${card.num||''}`;
    if (this._apiCache[cacheKey] !== undefined) return this._apiCache[cacheKey];

    const rawNum = card.num ? card.num.split('/')[0] : null;
    const numInt = rawNum && /^\d+$/.test(rawNum) ? parseInt(rawNum, 10) : null;

    // Primary: search by name + set
    try {
      const q = encodeURIComponent(`set.id:${setCode} name:"${cleanName}"`);
      const res = await fetch(
        `https://api.pokemontcg.io/v2/cards?q=${q}&select=id,images,number&orderBy=number`,
        { signal: AbortSignal.timeout(6000) }
      );
      const data = await res.json();
      const cards = data?.data || [];
      if (cards.length > 0) {
        let chosen = cards[0];
        if (numInt !== null && cards.length > 1) {
          const exact = cards.find(c => parseInt(c.number) === numInt);
          // For secret rares (num > total), prefer highest-numbered card
          chosen = exact || (numInt > 200 ? cards[cards.length - 1] : cards[0]);
        }
        const url = chosen.images?.large || chosen.images?.small || null;
        this._apiCache[cacheKey] = url;
        return url;
      }
    } catch {}

    // Fallback: search by number
    if (numInt !== null && setCode) {
      try {
        const res = await fetch(
          `https://api.pokemontcg.io/v2/cards?q=set.id:${setCode}+number:${numInt}&select=id,images`,
          { signal: AbortSignal.timeout(5000) }
        );
        const data = await res.json();
        const url = data?.data?.[0]?.images?.large || data?.data?.[0]?.images?.small || null;
        if (url) { this._apiCache[cacheKey] = url; return url; }
      } catch {}
    }

    this._apiCache[cacheKey] = null;
    return null;
  },

  // FIXED: One Piece image lookup with proper URL patterns and fallbacks
  async _onePiece(card) {
    if (!card.num || !/^OP\d{2}-\d{3}$/i.test(card.num)) return null;
    const num = card.num.toUpperCase();
    const setCode = num.split('-')[0]; // e.g. "OP01"

    // Try multiple CDN patterns — Limitless TCG hosts the most complete collection
    const urls = [
      `https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${setCode}/${num}_EN.webp`,
      `https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${setCode}/${num}.webp`,
    ];

    // Return first URL; lazy loader will try fallbacks on error
    return urls[0];
  },

  _sealed(card) {
    if (card.game === 'pokemon') {
      const setCode = this._POKE_SETS[card.set];
      if (setCode) return `https://images.pokemontcg.io/${setCode}/logo.png`;
    }
    if (card.game === 'onepiece') {
      const match = (card.set || card.name || '').match(/OP(\d{2})/i);
      if (match) {
        const setId = `OP${match[1]}`;
        return `https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${setId}/${setId}_DISPLAY_EN.webp`;
      }
    }
    return null;
  },
};

/* Lazy-load images with proper One Piece fallback chain */
function lazyLoadImages(cards, gridId) {
  cards.forEach(card => {
    CardImages.get(card).then(url => {
      if (!url) return;
      const grids = gridId
        ? [document.getElementById(gridId)]
        : ['grid-home','grid-pokemon','grid-onepiece','collectionList','grid-sell'].map(id => document.getElementById(id));
      grids.forEach(grid => {
        if (!grid) return;
        grid.querySelectorAll(`[data-card-id="${card.id}"] .thumb`).forEach(thumb => {
          const ph = thumb.querySelector('.thumb-placeholder');
          if (!ph) return;
          const img = document.createElement('img');
          img.alt = card.name;
          const isSealedLike = card.cat === 'sealed' || card.cat === 'case';
          img.style.cssText = `width:100%;height:100%;object-fit:${isSealedLike?'contain':'cover'};${isSealedLike?'padding:12px;':''}display:block;transition:transform .4s ease;`;

          if (card.game === 'onepiece' && card.num && /^OP\d{2}-\d{3}$/i.test(card.num)) {
            const num = card.num.toUpperCase();
            const set = num.split('-')[0];
            const srcs = [
              `https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${set}/${num}_EN.webp`,
              `https://limitlesstcg.nyc3.digitaloceanspaces.com/one-piece/${set}/${num}.webp`,
              `https://en.onepiece-cardgame.com/images/cardlist/card/${num}.png`,
            ];
            let attempt = 0;
            const tryNext = () => {
              if (attempt >= srcs.length) { delete IMG_CACHE[card.id]; return; }
              img.src = srcs[attempt++];
            };
            img.onerror = tryNext;
            tryNext();
          } else {
            img.src = url;
            img.onerror = () => { delete IMG_CACHE[card.id]; img.replaceWith(ph); };
          }
          ph.replaceWith(img);
        });
      });
    });
  });
}

/* ══ PRICE HELPERS ══ */
function calcPrice(card) {
  const g = S.store.global;
  const folder = S.store.folders.find(f => f.id === card.folder) || {};
  const pct  = folder.premiumPct  != null ? folder.premiumPct  : (card.game==='pokemon' ? g.pokePct  : g.opPct);
  const flat = folder.premiumFlat != null ? folder.premiumFlat : (card.game==='pokemon' ? g.pokeFlat : g.opFlat);
  return card.market * (1 + pct/100) + flat;
}

function fmt(usd, decimals = 2) {
  return window.Currency ? window.Currency.fmt(usd, decimals) : '$' + usd.toLocaleString('en-US', {minimumFractionDigits:decimals,maximumFractionDigits:decimals});
}

/* ══ INIT ══ */
window.onload = async () => {
  S.store.folders = JSON.parse(JSON.stringify(DEMO_FOLDERS));
  S.store.cards   = JSON.parse(JSON.stringify(DEMO_CARDS));
  if (window.Currency) await window.Currency.init();
  if (window.Currency) window.Currency.onChange(() => { renderAll(); if (S.user) renderCollection(); });
  renderAll();
  buildTicker();
  initBg();

  // Restore user session
  try {
    const saved = JSON.parse(localStorage.getItem('tcgp_session') || 'null');
    if (saved?.email) {
      const acc = Object.values(DEMO_ACCOUNTS).find(a => a.email===saved.email);
      if (acc) { S.collection = JSON.parse(JSON.stringify(DEMO_COLLECTION)); loginSuccess(acc); }
    }
  } catch {}
};

/* ══ AUTH ══ */
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function switchTab(tab, btn) {
  document.querySelectorAll('.login-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('panel-login').style.display  = tab==='login'  ? '' : 'none';
  document.getElementById('panel-signup').style.display = tab==='signup' ? '' : 'none';
}
function handleLogin() {
  const e = document.getElementById('l-email').value.trim();
  const p = document.getElementById('l-pass').value;
  if (!e || !p) { showToast('Fill in email and password','⚠️','err'); return; }
  const role = e.includes('admin') ? 'admin' : e.includes('seller') ? 'seller' : 'user';
  loginSuccess({ name: e.split('@')[0], email: e, role });
}
function handleSignup() {
  const n = document.getElementById('s-name').value.trim();
  const e = document.getElementById('s-email').value.trim();
  const p = document.getElementById('s-pass').value;
  if (!n||!e||!p) { showToast('Fill all fields','⚠️','err'); return; }
  if (p.length < 8) { showToast('Password must be 8+ chars','⚠️','err'); return; }
  loginSuccess({ name: n, email: e, role: 'user' });
}
function demoLogin(type) {
  const acc = DEMO_ACCOUNTS[type];
  S.collection = JSON.parse(JSON.stringify(DEMO_COLLECTION));
  loginSuccess(acc);
}
function loginSuccess(user) {
  S.user = user; S.role = user.role;
  try { localStorage.setItem('tcgp_session', JSON.stringify({email:user.email})); } catch {}
  closeModal('loginModal');
  document.getElementById('navSignIn').style.display  = 'none';
  document.getElementById('navChip').style.display    = 'flex';
  document.getElementById('navLogout').style.display  = '';
  document.getElementById('navCart').style.display    = '';
  document.getElementById('navCollect').style.display = '';
  document.getElementById('navName').textContent = user.name;
  const av = document.getElementById('navAv');
  av.textContent = user.name[0].toUpperCase();
  av.className   = `uav ${user.role}`;
  const rb = document.getElementById('navRoleBadge');
  rb.textContent = user.role;
  rb.className   = `nav-role-badge role-${user.role}`;
  if (user.role === 'admin' || user.role === 'seller') {
    document.getElementById('navSell').style.display  = '';
    document.getElementById('navAdmin').style.display = user.role==='admin' ? '' : 'none';
  }
  const mc = document.getElementById('mobNavCollect');
  const ms = document.getElementById('mobNavSell');
  if (mc) mc.style.display = '';
  if (ms && (user.role === 'admin' || user.role === 'seller')) ms.style.display = '';
  renderCollection(); renderSellDashboard(); renderUserTable();
  showToast(`Welcome, ${user.name}!`, '⚡');
}
function doLogout() {
  S.user=null; S.role=null; S.cart=[];
  try { localStorage.removeItem('tcgp_session'); } catch {}
  document.getElementById('navSignIn').style.display  = '';
  document.getElementById('navChip').style.display    = 'none';
  document.getElementById('navLogout').style.display  = 'none';
  document.getElementById('navCart').style.display    = 'none';
  document.getElementById('navCollect').style.display = 'none';
  document.getElementById('navSell').style.display    = 'none';
  document.getElementById('navAdmin').style.display   = 'none';
  const mc = document.getElementById('mobNavCollect');
  const ms = document.getElementById('mobNavSell');
  if (mc) mc.style.display = 'none';
  if (ms) ms.style.display = 'none';
  updateCartBadge();
  goPage('home'); showToast('Signed out','👋');
}
function setMobNav(btn) {
  document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

/* ══ CART ══ */
function addToCart(cardId) {
  if (!S.user) { openModal('loginModal'); return; }
  const card = S.store.cards.find(c => c.id===cardId);
  if (!card) return;
  const price = calcPrice(card);
  const existing = S.cart.find(i => i.id===cardId);
  if (existing) { existing.qty = Math.min(existing.qty+1, card.qty); showToast('Qty updated in cart','🛒'); }
  else { S.cart.push({id:card.id,name:card.name,set:card.set,cat:card.cat,price,qty:1}); showToast(`${card.name} added to cart`,'🛒'); }
  updateCartBadge();
}
function removeFromCart(cardId) {
  S.cart = S.cart.filter(i => i.id !== cardId);
  updateCartBadge(); renderCart();
}
function updateCartBadge() {
  const cnt = S.cart.reduce((s,i) => s+i.qty, 0);
  const el  = document.getElementById('cartCount');
  if (el) { el.textContent = cnt; el.classList.toggle('visible', cnt > 0); }
}
function openCartModal() { renderCart(); openModal('cartModal'); }
function renderCart() {
  const items = document.getElementById('cartItems');
  if (!S.cart.length) {
    items.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--muted);font-size:.88rem;font-weight:700;">Your cart is empty</div>`;
    document.getElementById('cartTotal').textContent = fmt(0);
    return;
  }
  items.innerHTML = S.cart.map(i =>
    `<div class="cart-item">
      <div class="ci-thumb">${i.cat==='sealed'?'📦':'🃏'}</div>
      <div class="ci-info"><div class="ci-name">${i.name}</div><div class="ci-set">${i.set||''}</div></div>
      <div class="ci-price">${fmt(i.price*i.qty)}</div>
      <button class="ci-remove" onclick="removeFromCart('${i.id}')">✕</button>
    </div>`
  ).join('');
  document.getElementById('cartTotal').textContent = fmt(S.cart.reduce((s,i) => s+i.price*i.qty, 0));
}
function doCheckout() { showToast('Checkout coming soon — contact seller to arrange','ℹ️'); }

/* ══ NAV / ROUTING ══ */
function goPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-'+name);
  if (page) page.classList.add('active');
  if (btn) btn.classList.add('active');
  else { const nb = document.querySelector(`[data-page="${name}"]`); if (nb) nb.classList.add('active'); }
  if (name==='home') renderHomeGrid();
  else if (name==='pokemon'||name==='onepiece') renderGrid(name);
  else if (name==='portfolio') {
    if (!S.user) { openModal('loginModal'); goPage('home'); return; }
    renderCollection();
  }
  else if (name==='sell') {
    if (!S.user||(S.role!=='admin'&&S.role!=='seller')) return;
    renderSellDashboard();
  }
}
function setCat(game, cat, btn) {
  S.ui[game].cat = cat;
  const row = document.getElementById(game==='pokemon'?'poke-cats':'op-cats');
  row.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderGrid(game);
}
function setGrader(game, grader, btn) {
  S.ui[game].grader = grader;
  const bar = document.getElementById(game==='pokemon'?'poke-graders':'op-graders');
  bar.querySelectorAll('.gr-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const cls = {PSA:'a-psa',CGC:'a-cgc',BGS:'a-bgs',TAG:'a-tag',all:'a-all'};
  btn.classList.add(cls[grader]||'');
  renderGrid(game);
}
function doSearch(game, v)       { S.ui[game].search = v;  renderGrid(game); }
function doFolderFilter(game, v) { S.ui[game].folder = v;  renderGrid(game); }
function doSort(game, v)         { S.ui[game].sort   = v;  renderGrid(game); }

/* ══ TOAST ══ */
let toastTmr;
function showToast(msg, icon='✓', type='ok') {
  const t = document.getElementById('toast');
  document.getElementById('t-msg').textContent = msg;
  document.getElementById('t-ic').textContent  = icon;
  t.className = 'toast show ' + type;
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ══ TICKER ══ */
const TICKERS = [
  {n:'Charizard ex SAR',p:148,d:'up',pct:'+3.2%',g:'poke',i:'⚡'},
  {n:'Pikachu Illustrator PSA 7',p:4200,d:'dn',pct:'-0.8%',g:'poke',i:'🏆'},
  {n:'Luffy OP01 PSA 10',p:380,d:'up',pct:'+2.4%',g:'op',i:'⚓'},
  {n:'Miraidon ex SAR CGC 9.5',p:190,d:'up',pct:'+5.1%',g:'poke',i:'🏆'},
  {n:'Zoro Alt Art CGC 10',p:290,d:'up',pct:'+1.9%',g:'op',i:'🏆'},
  {n:'Umbreon VMAX BGS 9',p:1800,d:'dn',pct:'-1.2%',g:'poke',i:'🏆'},
  {n:'Shanks OP04 PSA 9',p:180,d:'up',pct:'+3.5%',g:'op',i:'⚓'},
  {n:'SV7 Booster Box',p:520,d:'up',pct:'+0.9%',g:'poke',i:'📦'},
  {n:'OP01 Booster Box',p:210,d:'dn',pct:'-2.1%',g:'op',i:'📦'},
  {n:'151 ETB Sealed',p:74,d:'up',pct:'+1.5%',g:'poke',i:'📦'},
  {n:'Yamato Full Art OP04',p:35,d:'up',pct:'+4.8%',g:'op',i:'⚓'},
  {n:'Rayquaza VMAX BGS 9.5',p:420,d:'up',pct:'+2.3%',g:'poke',i:'🏆'},
  {n:'Ace OP02 PSA 10',p:310,d:'up',pct:'+6.1%',g:'op',i:'🏆'},
  {n:'Charizard ex JPN SAR PSA 10',p:580,d:'up',pct:'+4.2%',g:'poke',i:'🏆'},
  {n:'Mew ex JPN SAR',p:55,d:'dn',pct:'-1.8%',g:'poke',i:'⚡'},
];
function buildTicker() {
  const d = [...TICKERS,...TICKERS,...TICKERS];
  document.getElementById('tickerInner').innerHTML = d.map(t =>
    `<span class="t-item"><span class="t-thumb ${t.g}">${t.i}</span><span class="tn">${t.n}</span>${fmt(t.p,0)}<span class="${t.d}">${t.pct}</span><span class="t-sep"> | </span></span>`
  ).join('');
}

/* ══ BG CANVAS ══ */
function initBg() {
  const canvas = document.getElementById('bg-canvas');
  const ctx    = canvas.getContext('2d');
  let W, H, shapes;
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  function mk() {
    return {
      x:Math.random()*W, y:Math.random()*H,
      r:6+Math.random()*18, dx:(Math.random()-.5)*.3, dy:(Math.random()-.5)*.3,
      alpha:.04+Math.random()*.08,
      type:Math.random()>.5?'c':'d',
      hue:Math.random()>.5?48:220
    };
  }
  function init() { resize(); shapes = Array.from({length:20},mk); }
  function draw() {
    ctx.clearRect(0,0,W,H);
    shapes.forEach(s => {
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle   = `hsl(${s.hue},90%,58%)`;
      if (s.type==='c') { ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(s.x,s.y-s.r); ctx.lineTo(s.x+s.r,s.y); ctx.lineTo(s.x,s.y+s.r); ctx.lineTo(s.x-s.r,s.y); ctx.closePath(); ctx.fill(); }
      s.x+=s.dx; s.y+=s.dy;
      if(s.x<-50)s.x=W+50; if(s.x>W+50)s.x=-50;
      if(s.y<-50)s.y=H+50; if(s.y>H+50)s.y=-50;
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  init(); draw(); window.addEventListener('resize', resize);
}

/* ══ RENDER STORE ══ */
function renderAll() {
  renderHomeGrid();
  renderGrid('pokemon');
  renderGrid('onepiece');
  updateFolderSelects();
}
function updateFolderSelects() {
  ['poke-fsel','op-fsel'].forEach(sid => {
    const sel = document.getElementById(sid); if (!sel) return;
    const game = sid.startsWith('poke') ? 'pokemon' : 'onepiece';
    const folders = S.store.folders.filter(f => (f.game===game||f.game==='mixed') && f.enabled);
    const val = sel.value;
    sel.innerHTML = '<option value="">All portfolios</option>' + folders.map(f=>`<option value="${f.id}">${f.name}</option>`).join('');
    sel.value = val;
  });
}
function renderHomeGrid() {
  const allCards = S.store.cards.filter(c => S.store.folders.find(f=>f.id===c.folder)?.enabled);
  document.getElementById('home-cnt').textContent = allCards.length+' items';
  const grid = document.getElementById('grid-home');
  if (!allCards.length) { grid.innerHTML = emptyState(); return; }
  grid.innerHTML = allCards.slice(0,24).map(c => renderTile(c)).join('');
  lazyLoadImages(allCards.slice(0,24), 'grid-home');
  const poke = allCards.filter(c=>c.game==='pokemon');
  const op   = allCards.filter(c=>c.game==='onepiece');
  document.getElementById('poke-stats').textContent = `${poke.length} listings · ${fmt(poke.reduce((s,c)=>s+calcPrice(c),0),0)} total`;
  document.getElementById('op-stats').textContent   = `${op.length} listings · ${fmt(op.reduce((s,c)=>s+calcPrice(c),0),0)} total`;
  document.getElementById('sectionCards').style.display = '';
}
function renderGrid(game) {
  const ui = S.ui[game];
  const enabledFolders = new Set(S.store.folders.filter(f=>(f.game===game||f.game==='mixed')&&f.enabled).map(f=>f.id));
  let cards = S.store.cards.filter(c => c.game===game && enabledFolders.has(c.folder));
  if (ui.cat !== 'all') cards = cards.filter(c => c.cat === ui.cat);
  if (ui.cat === 'slab' && ui.grader !== 'all') cards = cards.filter(c => c.grader === ui.grader);
  if (ui.search) cards = cards.filter(c => c.name.toLowerCase().includes(ui.search.toLowerCase())||c.set.toLowerCase().includes(ui.search.toLowerCase()));
  if (ui.folder) cards = cards.filter(c => c.folder === ui.folder);
  cards = sortCards(cards, ui.sort);
  const all = S.store.cards.filter(c => c.game===game && enabledFolders.has(c.folder));
  const gn  = game==='pokemon' ? 'poke' : 'op';
  ['all','raw','sealed','slab','case'].forEach(cat => {
    const el = document.getElementById(`cnt-${gn}-${cat}`);
    if (el) el.textContent = cat==='all' ? all.length : all.filter(c=>c.cat===cat).length;
  });
  document.getElementById(gn+'-cnt').textContent = cards.length+' items';
  document.getElementById(`${game==='pokemon'?'poke':'op'}-graders`).style.display = ui.cat==='slab' ? '' : 'none';
  document.getElementById('grid-'+game).innerHTML = cards.map(c=>renderTile(c)).join('') || emptyState();
  lazyLoadImages(cards, 'grid-'+game);
}

function renderTile(card, mode) {
  const f       = S.store.folders.find(f => f.id===card.folder);
  const listed  = calcPrice(card);
  const isListed= f?.enabled;
  const emoji   = card.cat==='sealed'?'📦':card.cat==='case'?'🗃':card.cat==='slab'?'🏆':card.game==='pokemon'?'⚡':'⚓';
  const thumbBg = card.game==='pokemon' ? 'poke-bg' : 'op-bg';
  const langBadge = card.lang === 'Japanese' ? `<div class="lang-badge">🇯🇵 JPN</div>` : '';
  const thumbContent = IMG_CACHE[card.id]
    ? `<img src="${IMG_CACHE[card.id]}" alt="${card.name}" style="width:100%;height:100%;object-fit:${card.cat==='sealed'||card.cat==='case'?'contain;padding:12px':'cover'};display:block;">`
    : `<div class="thumb-placeholder"><span>${emoji}</span><span class="ph-label">${card.set||''}</span></div>`;
  const ctaRow = S.user
    ? `<button class="cta-btn buy ${card.game==='onepiece'?'op':''}" onclick="event.stopPropagation();addToCart('${card.id}')">🛒 Buy</button>
       <button class="cta-btn track" onclick="event.stopPropagation();showAddToCollection('${card.id}')">📚 Track</button>`
    : `<button class="cta-btn buy ${card.game==='onepiece'?'op':''}" onclick="event.stopPropagation();openModal('loginModal')">🛒 Buy</button>`;
  return `<div class="tile ${card.game==='pokemon'?'poke':'op'}" data-card-id="${card.id}" onclick="openCard('${card.id}')">
    <div class="thumb ${thumbBg}">
      ${thumbContent}
      ${card.grader ? `<div class="gr-ribbon ${card.grader.toLowerCase()}">${card.grader}</div>` : ''}
      ${card.grade  ? `<div class="gr-num">${card.grade}</div>` : ''}
      ${langBadge}
      ${mode==='sell' ? `<div class="listed-badge ${isListed?'listed-yes':'listed-no'}">${isListed?'Listed':'Hidden'}</div>` : ''}
    </div>
    <div class="tile-info">
      <div class="type-badge tb-${card.cat}">${card.cat==='raw'?'🃏 Raw':card.cat==='sealed'?'📦 Sealed':card.cat==='slab'?'🏆 Slab':'🗃 Case'}</div>
      <div class="card-name">${card.name}</div>
      <div class="card-set">${card.set}${card.num?' · '+card.num:''}</div>
      <div class="price-row"><span class="price-final">${fmt(listed)}</span></div>
      <div class="card-qty">Qty: ${card.qty}</div>
      <div class="cta-row">${ctaRow}</div>
    </div>
  </div>`;
}
function renderCollTile(card) {
  const gain    = card.market - (card.paid||0);
  const gainPct = card.paid>0 ? (gain/card.paid*100) : 0;
  const emoji   = card.cat==='sealed'?'📦':card.cat==='case'?'🗃':card.cat==='slab'?'🏆':card.game==='pokemon'?'⚡':'⚓';
  const thumbBg = card.game==='pokemon' ? 'poke-bg' : 'op-bg';
  const langBadge = card.lang === 'Japanese' ? `<div class="lang-badge">🇯🇵 JPN</div>` : '';
  const thumbContent = IMG_CACHE[card.id]
    ? `<img src="${IMG_CACHE[card.id]}" alt="${card.name}" style="width:100%;height:100%;object-fit:${card.cat==='sealed'||card.cat==='case'?'contain;padding:10px':'cover'};display:block;">`
    : `<div class="thumb-placeholder"><span>${emoji}</span></div>`;
  return `<div class="coll-tile tile" data-card-id="${card.id}" onclick="openCollCard('${card.id}')">
    <div class="thumb ${thumbBg}" style="height:170px;">${thumbContent}
      ${card.grader ? `<div class="gr-ribbon ${card.grader.toLowerCase()}">${card.grader}</div>` : ''}
      ${card.grade  ? `<div class="gr-num">${card.grade}</div>` : ''}
      ${langBadge}
    </div>
    <div class="tile-info">
      <div class="type-badge tb-${card.cat}">${card.cat==='raw'?'🃏 Raw':card.cat==='sealed'?'📦 Sealed':card.cat==='slab'?'🏆 Slab':'🗃 Case'}</div>
      <div class="card-name">${card.name}</div>
      <div class="card-set">${card.set}${card.num?' · '+card.num:''}</div>
      <div class="price-row"><span class="price-final" style="color:var(--navy)">${fmt(card.market)}</span></div>
      ${card.paid ? `<div class="coll-gain ${gain>=0?'pos':'neg'}">${gain>=0?'▲':'▼'} ${Math.abs(gainPct).toFixed(1)}% (${gain>=0?'+':''}${fmt(Math.abs(gain))})</div>` : ''}
      <div class="card-qty">Qty: ${card.qty}</div>
      <div class="coll-tile-actions"><button class="cta-btn del" onclick="event.stopPropagation();deleteCollCard('${card.id}')">🗑</button></div>
    </div>
  </div>`;
}
function renderCollTileForSale(card) {
  const port    = S.collection.portfolios.find(p => p.id === card.portfolio);
  const listed  = card.market;
  const emoji   = card.cat==='sealed'?'📦':card.cat==='case'?'🗃':card.cat==='slab'?'🏆':card.game==='pokemon'?'⚡':'⚓';
  const thumbBg = card.game==='pokemon' ? 'poke-bg' : 'op-bg';
  const langBadge = card.lang === 'Japanese' ? `<div class="lang-badge">🇯🇵 JPN</div>` : '';
  const thumbContent = IMG_CACHE[card.id]
    ? `<img src="${IMG_CACHE[card.id]}" alt="${card.name}" style="width:100%;height:100%;object-fit:${card.cat==='sealed'||card.cat==='case'?'contain;padding:10px':'cover'};display:block;">`
    : `<div class="thumb-placeholder"><span>${emoji}</span><span class="ph-label">${card.set||''}</span></div>`;
  const isListed = port?.listed;
  return `<div class="tile ${card.game==='pokemon'?'poke':'op'}" data-card-id="${card.id}" onclick="openCollCard('${card.id}')">
    <div class="thumb ${thumbBg}">
      ${thumbContent}
      ${card.grader ? `<div class="gr-ribbon ${card.grader.toLowerCase()}">${card.grader}</div>` : ''}
      ${card.grade  ? `<div class="gr-num">${card.grade}</div>` : ''}
      ${langBadge}
      <div class="listed-badge ${isListed?'listed-yes':'listed-no'}">${isListed?'Listed':'Not Listed'}</div>
    </div>
    <div class="tile-info">
      <div class="type-badge tb-${card.cat}">${card.cat==='raw'?'🃏 Raw':card.cat==='sealed'?'📦 Sealed':card.cat==='slab'?'🏆 Slab':'🗃 Case'}</div>
      <div class="card-name">${card.name}</div>
      <div class="card-set">${card.set}${card.num?' · '+card.num:''}</div>
      <div class="price-row"><span class="price-final">${fmt(listed)}</span></div>
      <div class="card-qty">Qty: ${card.qty}</div>
      <div class="cta-row">
        <button class="cta-btn buy ${card.game==='onepiece'?'op':''}" onclick="event.stopPropagation();addToCart('${card.id}')">🛒 Buy</button>
        <button class="cta-btn del" onclick="event.stopPropagation();deleteCollCard('${card.id}')">🗑</button>
      </div>
    </div>
  </div>`;
}
function sortCards(cards, sort) {
  return [...cards].sort((a,b) => {
    if (sort==='price-desc') return calcPrice(b)-calcPrice(a);
    if (sort==='price-asc')  return calcPrice(a)-calcPrice(b);
    if (sort==='grade-desc') return (b.grade||0)-(a.grade||0);
    if (sort==='name')       return a.name.localeCompare(b.name);
    return 0;
  });
}
function emptyState() {
  return `<div class="empty-state"><div class="empty-icon">🃏</div><div class="empty-title">No items found</div><div class="empty-sub">Try a different filter or check back soon.</div></div>`;
}

/* ══ CARD DETAIL MODAL ══ */
async function openCard(cardId) {
  const card = S.store.cards.find(c => c.id===cardId);
  if (!card) return;
  S.detailCard = card;
  const folder = S.store.folders.find(f=>f.id===card.folder)||{};
  const listed = calcPrice(card);
  document.getElementById('cdTitle').textContent = card.name;
  document.getElementById('cdSet').textContent   = `${card.set}${card.num?' · '+card.num:''}${card.lang?' · 🇯🇵 Japanese':''}`;
  document.getElementById('cdMarket').textContent = fmt(card.market);
  document.getElementById('cdListed').textContent = fmt(listed);
  document.getElementById('cdQty').textContent    = card.qty;
  document.getElementById('cdPortfolio').textContent = folder.name||'';
  const prem = listed - card.market;
  const premEl = document.getElementById('cdPremium');
  premEl.textContent = prem>0.01 ? `+${fmt(prem)} over market` : 'At market price';
  premEl.className   = `sub ${prem>0?'up':''}`;
  document.getElementById('cdPaid').textContent = card.paid ? fmt(card.paid) : '—';
  document.getElementById('cdMarketChange').textContent = card.set;
  const badges = [];
  if (card.cat==='slab'&&card.grader) {
    badges.push(`<span class="gr-ribbon ${card.grader.toLowerCase()}" style="position:static;font-size:.65rem;">${card.grader}</span>`);
    if (card.grade) badges.push(`<span style="font-size:.74rem;font-weight:900;padding:.12rem .5rem;border-radius:4px;background:var(--surf2);border:2px solid var(--border);">${card.grade}</span>`);
  }
  badges.push(`<span class="type-badge tb-${card.cat}">${{raw:'Raw Single',sealed:'Sealed',slab:'Graded Slab',case:'Sealed Case'}[card.cat]||card.cat}</span>`);
  if (card.lang === 'Japanese') badges.push(`<span class="type-badge" style="background:#FEF3C7;color:#92400E;">🇯🇵 Japanese</span>`);
  document.getElementById('cdBadges').innerHTML  = badges.join('');
  document.getElementById('cdActions').innerHTML = buildCardActions(card, listed);
  const imgWrap = document.getElementById('cdImgWrap');
  imgWrap.className = 'cd-card-placeholder';
  imgWrap.innerHTML = `<span>${card.cat==='sealed'?'📦':card.cat==='case'?'🗃':'🃏'}</span><span class="pname">${card.name}</span>`;
  openModal('cardDetailModal');

  // Default to 30d; reset range buttons
  S.ui.chartRange = 30;
  document.querySelectorAll('.cd-range-btn').forEach(b => b.classList.remove('active'));
  const btn30 = document.querySelector('.cd-range-btn[data-days="30"]');
  if (btn30) btn30.classList.add('active');

  await loadPriceChart(card, 30);
  CardImages.get(card).then(url => {
    if (!url) return;
    imgWrap.className = '';
    const isSealedLike = card.cat==='sealed'||card.cat==='case';
    imgWrap.innerHTML = `<img class="cd-card-img" src="${url}" alt="${card.name}"
      style="${isSealedLike?'object-fit:contain;padding:16px;':'background:transparent;'}"
      onerror="this.parentElement.className='cd-card-placeholder';this.parentElement.innerHTML='<span>🃏</span>'">`;
  });
}

async function openCollCard(cardId) {
  const card = S.collection.cards.find(c => c.id===cardId);
  if (!card) return;
  S.detailCard = card;
  const listed = card.market;
  document.getElementById('cdTitle').textContent  = card.name;
  document.getElementById('cdSet').textContent    = `${card.set}${card.num?' · '+card.num:''}${card.lang?' · 🇯🇵 Japanese':''}`;
  document.getElementById('cdMarket').textContent = fmt(card.market);
  document.getElementById('cdListed').textContent = fmt(card.market);
  document.getElementById('cdQty').textContent    = card.qty;
  const port = S.collection.portfolios.find(p=>p.id===card.portfolio);
  document.getElementById('cdPortfolio').textContent = port?.name||'';
  const gain = card.market-(card.paid||0);
  const gainEl = document.getElementById('cdPremium');
  gainEl.textContent = gain!==0 ? `${gain>0?'+':''}${fmt(gain)} vs paid` : 'No gain/loss';
  gainEl.className   = `sub ${gain>0?'up':gain<0?'dn':''}`;
  document.getElementById('cdPaid').textContent = card.paid ? fmt(card.paid) : '—';
  document.getElementById('cdMarketChange').textContent = card.set;
  const badges = [];
  if (card.cat==='slab'&&card.grader) {
    badges.push(`<span class="gr-ribbon ${card.grader.toLowerCase()}" style="position:static;font-size:.65rem;">${card.grader}</span>`);
    if (card.grade) badges.push(`<span style="font-size:.74rem;font-weight:900;padding:.12rem .5rem;border-radius:4px;background:var(--surf2);border:2px solid var(--border);">${card.grade}</span>`);
  }
  badges.push(`<span class="type-badge tb-${card.cat}">${{raw:'Raw Single',sealed:'Sealed',slab:'Graded Slab',case:'Sealed Case'}[card.cat]||card.cat}</span>`);
  if (card.lang === 'Japanese') badges.push(`<span class="type-badge" style="background:#FEF3C7;color:#92400E;">🇯🇵 Japanese</span>`);
  document.getElementById('cdBadges').innerHTML  = badges.join('');
  document.getElementById('cdActions').innerHTML = `<button class="cd-btn cd-btn-danger" onclick="deleteCollCard('${card.id}');closeModal('cardDetailModal')">🗑 Remove from Collection</button>`;
  const imgWrap = document.getElementById('cdImgWrap');
  imgWrap.className = 'cd-card-placeholder';
  imgWrap.innerHTML = `<span>${card.cat==='sealed'?'📦':card.cat==='case'?'🗃':'🃏'}</span><span class="pname">${card.name}</span>`;
  openModal('cardDetailModal');

  S.ui.chartRange = 30;
  document.querySelectorAll('.cd-range-btn').forEach(b => b.classList.remove('active'));
  const btn30 = document.querySelector('.cd-range-btn[data-days="30"]');
  if (btn30) btn30.classList.add('active');

  await loadPriceChart(card, 30);
  CardImages.get(card).then(url => {
    if (!url) return;
    imgWrap.className = '';
    imgWrap.innerHTML = `<img class="cd-card-img" src="${url}" alt="${card.name}" onerror="this.parentElement.className='cd-card-placeholder';this.parentElement.innerHTML='<span>🃏</span>'">`;
  });
}

function buildCardActions(card, listed) {
  if (!S.user) return `<button class="cd-btn cd-btn-secondary" onclick="closeModal('cardDetailModal');openModal('loginModal')">Sign In to Buy or Track</button>`;
  let html = '';
  if (S.role==='user') {
    html += `<button class="cd-btn cd-btn-primary" onclick="addToCart('${card.id}')">🛒 Add to Cart — ${fmt(listed)}</button>`;
    html += `<button class="cd-btn cd-btn-secondary" onclick="showAddToCollection('${card.id}')">📚 Add to My Collection</button>`;
  }
  if (S.role==='seller'||S.role==='admin') {
    const f = S.store.folders.find(f=>f.id===card.folder);
    html += `<button class="cd-btn ${f?.enabled?'cd-btn-danger':'cd-btn-seller'}" onclick="toggleFolder('${f?.id}')">${f?.enabled?'⏸ Unlist Portfolio':'✅ List Portfolio'}</button>`;
    html += `<button class="cd-btn cd-btn-secondary" onclick="showAddToCollection('${card.id}')">📚 Add to My Collection</button>`;
    html += `<button class="cd-btn cd-btn-primary" onclick="addToCart('${card.id}')">🛒 Add to Cart — ${fmt(listed)}</button>`;
  }
  return html;
}

/* ══ PRICE CHART — EXTENDED RANGES WITH EBAY SLAB DATA ══ */
async function changeRange(days, btn) {
  S.ui.chartRange = days;
  document.querySelectorAll('.cd-range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (S.detailCard) await loadPriceChart(S.detailCard, days);
}

async function loadPriceChart(card, days) {
  days = days || S.ui.chartRange || 30;
  if (S.priceChart) { S.priceChart.destroy(); S.priceChart = null; }

  const market = card.market;
  const seed = (card.id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  let lcg = (seed * 1664525 + 1013904223) & 0xffffffff;
  function rand() { lcg = (lcg * 1664525 + 1013904223) & 0xffffffff; return (lcg >>> 0) / 0xffffffff; }

  let pts = [];
  let dataSource = '📊 Simulated Market Data';
  let ebayBubbles = []; // eBay actual sale dots for slabs

  if (card.cat === 'slab') {
    // Use eBay slab API data
    dataSource = '🔴 eBay Sold Listings (Simulated)';
    const slabData = await EbaySlabAPI.fetchSlabHistory(card);
    if (slabData && slabData.sales.length > 0) {
      // Build timeseries from actual sales
      const actualPts = EbaySlabAPI.getSlabPriceTimeseries(slabData.sales, days);
      if (actualPts.length > 1) {
        pts = actualPts.map(p => ({
          date: p.date.toLocaleDateString('en-CA', { month:'short', day:'numeric' }),
          price: p.price,
          volume: p.volume,
        }));
        // Collect individual sale dots for scatter overlay
        const cutoff = Date.now() - days * 86400000;
        ebayBubbles = slabData.sales
          .filter(s => new Date(s.saleDate).getTime() >= cutoff)
          .map(s => ({
            x: new Date(s.saleDate).toLocaleDateString('en-CA', { month:'short', day:'numeric' }),
            y: parseFloat(s.salePrice) + parseFloat(s.shippingCost || 0),
            type: s.listingType,
          }));
      }
    }
  }

  // Fallback / non-slab: generate smooth simulated timeseries
  if (!pts.length) {
    // For long ranges, generate a plausible multi-year price trajectory
    const totalDays = days === 9999 ? 1825 : days; // "max" = 5 years
    const startPrice = (card.paid && card.paid > 0)
      ? card.paid * (0.9 + rand() * 0.2)
      : market * (0.65 + (seed % 30) * 0.01);

    // Number of data points — more granular for short ranges
    const numPts = totalDays <= 7 ? totalDays : totalDays <= 30 ? totalDays : totalDays <= 90 ? Math.ceil(totalDays/2) : Math.ceil(totalDays/7);

    let price = startPrice;
    for (let i = numPts; i >= 0; i--) {
      const dayOffset = (i / numPts) * totalDays;
      const drift = (market - startPrice) / numPts;
      // Add some market cycles for longer ranges
      const cycle = totalDays > 90 ? Math.sin((i / numPts) * Math.PI * 3) * market * 0.05 : 0;
      price += drift + price * (rand() - 0.5) * (totalDays > 365 ? 0.04 : 0.05) + cycle;
      price = Math.max(price, market * 0.15);
      price = Math.min(price, market * 4.0);
      const d = new Date(); d.setDate(d.getDate() - Math.round(dayOffset));
      const fmt_label = totalDays > 365
        ? d.toLocaleDateString('en-CA', { month:'short', year:'2-digit' })
        : d.toLocaleDateString('en-CA', { month:'short', day:'numeric' });
      pts.push({ date: fmt_label, price: +price.toFixed(2) });
    }
    pts.reverse();
    pts[pts.length - 1].price = market;
  }

  const labels = pts.map(p => p.date);
  const data   = pts.map(p => p.price);
  const trend  = market >= (pts[0]?.price || market);
  const color  = trend ? '#16A34A' : '#DC2626';
  const ctx    = document.getElementById('cdPriceChart').getContext('2d');
  const grad   = ctx.createLinearGradient(0, 0, 0, 130);
  grad.addColorStop(0, trend ? 'rgba(22,163,74,0.22)' : 'rgba(220,38,38,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');

  const datasets = [{
    label: 'Price',
    data, borderColor: color, borderWidth: 2,
    backgroundColor: grad, fill: true, tension: 0.35,
    pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: color,
    order: 2,
  }];

  // Add eBay scatter dots for slabs
  if (ebayBubbles.length > 0) {
    // Map sale x to label index (approximate)
    const labelSet = new Set(labels);
    const scatterData = ebayBubbles
      .filter(b => labelSet.has(b.x))
      .map(b => ({ x: b.x, y: b.y }))
      .slice(0, 200);
    if (scatterData.length) {
      datasets.push({
        label: 'eBay Sales',
        type: 'scatter',
        data: scatterData,
        backgroundColor: 'rgba(234,88,12,0.55)',
        borderColor: 'rgba(234,88,12,0.9)',
        borderWidth: 1,
        pointRadius: 3,
        pointStyle: 'circle',
        order: 1,
      });
    }
  }

  // Update data source label
  const srcEl = document.getElementById('cdSourceTag');
  if (srcEl) srcEl.textContent = card.cat==='slab' ? '🔴 eBay Sold Listings · Weighted Avg' : '📊 JustTCG Market Data';

  S.priceChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: ebayBubbles.length > 0, position: 'top', labels: { color: '#6B7A99', font: { family: 'Nunito', size: 10, weight: '700' }, boxWidth: 10 } },
        tooltip: {
          mode: 'index', intersect: false,
          backgroundColor: '#1A2744', borderColor: 'rgba(43,92,230,0.3)', borderWidth: 1,
          titleColor: '#6B7A99', bodyColor: '#fff',
          callbacks: {
            title: items => items[0].label,
            label: c => ` ${c.dataset.label}: ${fmt(c.raw?.y ?? c.raw)}`,
          }
        },
      },
      scales: {
        x: { display: false },
        y: {
          display: true,
          grid: { color: 'rgba(43,92,230,0.06)' },
          ticks: { color: '#6B7A99', font: { family: 'Nunito', size: 10, weight: '700' }, callback: v => fmt(v, 0) },
        }
      }
    }
  });
}

/* ══ COLLECTION ══ */
function renderCollection() {
  if (!S.user) return;
  const {portfolios,cards,activePortfolioId} = S.collection;
  const totalMkt  = cards.reduce((s,c)=>s+c.market*c.qty,0);
  const totalPaid = cards.reduce((s,c)=>s+(c.paid||0)*c.qty,0);
  const gain = totalMkt-totalPaid;
  const gainPct = totalPaid>0?(gain/totalPaid*100):0;
  document.getElementById('collStats').innerHTML = `
    <div class="stat-card"><div class="stat-label">Total Value</div><div class="stat-value yellow">${fmt(totalMkt)}</div></div>
    <div class="stat-card"><div class="stat-label">Total Cost</div><div class="stat-value">${fmt(totalPaid)}</div></div>
    <div class="stat-card"><div class="stat-label">Gain / Loss</div><div class="stat-value ${gain>=0?'green':''}">${gain>=0?'+':''}${fmt(Math.abs(gain))}</div><div class="stat-change ${gain>=0?'up':'dn'}">${gain>=0?'▲':'▼'} ${Math.abs(gainPct).toFixed(1)}%</div></div>
    <div class="stat-card"><div class="stat-label">Cards</div><div class="stat-value">${cards.length}</div></div>
    <div class="stat-card"><div class="stat-label">Portfolios</div><div class="stat-value">${portfolios.length}</div></div>
    <div class="stat-card coll-view-toggle-card">
      <div class="stat-label">View Mode</div>
      <div class="coll-view-toggle">
        <button class="cvt-btn ${S.ui.collView==='collection'?'active':''}" onclick="setCollView('collection')">📚 Collection</button>
        <button class="cvt-btn ${S.ui.collView==='forsale'?'active':''}" onclick="setCollView('forsale')">💰 For Sale</button>
      </div>
    </div>`;
  const tabsRow = document.getElementById('portfolioTabsRow');
  tabsRow.innerHTML = portfolios.map(p => {
    const cnt    = cards.filter(c=>c.portfolio===p.id).length;
    const active = p.id===activePortfolioId;
    return `<button class="port-tab ${active?'active':''}" onclick="setActivePortfolio('${p.id}')">
      🎴 ${p.name}
      <span class="pt-cnt">${cnt}</span></button>`;
  }).join('') + `<button class="port-tab port-tab-new" onclick="openModal('newPortfolioModal')">＋ New</button>`;
  renderCollectionCards();
  const mSel = document.getElementById('mPortfolio');
  if (mSel) mSel.innerHTML = portfolios.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
}
function setActivePortfolio(id) { S.collection.activePortfolioId=id; renderCollection(); }
function setCollView(view) { S.ui.collView = view; renderCollection(); }
function renderCollectionCards() {
  const {portfolios,cards,activePortfolioId} = S.collection;
  const container = document.getElementById('collectionList');
  if (!portfolios.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📚</div><div class="empty-title">No portfolios yet</div><div class="empty-sub">Create a portfolio or import a Collectr CSV.</div></div>`;
    return;
  }
  const port      = portfolios.find(p=>p.id===activePortfolioId);
  const showCards = activePortfolioId ? cards.filter(c=>c.portfolio===activePortfolioId) : cards;
  const portMkt   = showCards.reduce((s,c)=>s+c.market*c.qty,0);
  const portPaid  = showCards.reduce((s,c)=>s+(c.paid||0)*c.qty,0);
  const portGain  = portMkt-portPaid;
  let headerHtml = '';
  if (port) {
    const isListed = port.listed;
    headerHtml = `<div class="coll-portfolio-header">
      <div class="cph-left">
        <div class="cph-title">${port.name}</div>
        <span style="font-size:.72rem;color:var(--muted);font-weight:700;">${showCards.length} cards · ${fmt(portMkt)} · ${portGain>=0?'+':''}${fmt(portGain)} G/L</span>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
        ${(S.role==='seller'||S.role==='admin')?`<button class="cph-listed-toggle ${isListed?'listed':''}" onclick="togglePortfolioListed('${port.id}')"><div class="ts-track ${isListed?'on':''}"><div class="ts-thumb"></div></div>${isListed?'Listed in Store':'Not Listed'}</button>`:''}
        <button class="ph-btn danger" onclick="confirmDeletePortfolio('${port.id}')">🗑 Delete</button>
      </div></div>`;
  }
  if (!showCards.length) {
    container.innerHTML = headerHtml+`<div class="empty-state"><div class="empty-icon">🃏</div><div class="empty-title">No cards in this portfolio</div><div class="empty-sub">Add cards via search or import a CSV.</div></div>`;
    return;
  }
  container.innerHTML = headerHtml+`<div class="coll-cards-grid">${showCards.map(c => S.ui.collView === 'forsale' ? renderCollTileForSale(c) : renderCollTile(c)).join('')}</div>`;
  lazyLoadImages(showCards, 'collectionList');
}
function togglePortfolioListed(portId) {
  const p = S.collection.portfolios.find(p=>p.id===portId); if (!p) return;
  p.listed = !p.listed;
  if (p.listed) {
    const portCards = S.collection.cards.filter(c=>c.portfolio===portId);
    if (!S.store.folders.find(f=>f.id===portId)) {
      S.store.folders.push({id:portId,name:p.name,game:'mixed',enabled:true,premiumPct:5,premiumFlat:0});
      portCards.forEach(c=>{ if(!S.store.cards.find(sc=>sc.id===c.id+'_listed')) S.store.cards.push({...c,id:c.id+'_listed',folder:portId}); });
      renderAll(); renderSellDashboard();
    } else { const f=S.store.folders.find(f=>f.id===portId); if(f) f.enabled=true; renderAll(); }
  } else {
    const f=S.store.folders.find(f=>f.id===portId); if(f) f.enabled=false; renderAll();
  }
  renderCollection();
  showToast(p.listed?`"${p.name}" listed in store`:`"${p.name}" hidden from store`,'✓');
}
function showAddToCollection(cardId) {
  if (!S.user) { openModal('loginModal'); return; }
  const card = S.store.cards.find(c=>c.id===cardId); if (!card) return;
  S.pendingAddCard = cardId;
  document.getElementById('addingCardName').textContent = card.name;
  document.getElementById('addPaidInput').value = card.market.toFixed(2);
  const picker = document.getElementById('portfolioListPicker');
  picker.innerHTML = S.collection.portfolios.map(p=>{
    const cnt = S.collection.cards.filter(c=>c.portfolio===p.id).length;
    return `<div class="plp-item ${S.pendingPortfolio===p.id?'selected':''}" onclick="selectPortfolio('${p.id}',this)">
      <span class="plp-name">🎴 ${p.name}</span>
      <span class="plp-count">${cnt} cards</span></div>`;
  }).join('')+`<div class="plp-item plp-new" onclick="openModal('newPortfolioModal')">＋ Create New Portfolio</div>`;
  if (S.collection.portfolios.length) S.pendingPortfolio = S.collection.portfolios[0].id;
  openModal('addPortfolioModal');
}
function selectPortfolio(id, el) {
  S.pendingPortfolio = id;
  document.querySelectorAll('.plp-item').forEach(e=>e.classList.remove('selected'));
  el.classList.add('selected');
}
function confirmAddToPortfolio() {
  if (!S.pendingAddCard||!S.pendingPortfolio) { showToast('Select a portfolio','⚠️','err'); return; }
  const card = S.store.cards.find(c=>c.id===S.pendingAddCard); if (!card) return;
  const paid = parseFloat(document.getElementById('addPaidInput').value)||card.market;
  S.collection.cards.push({id:'cc'+Date.now(),name:card.name,set:card.set,num:card.num,game:card.game,cat:card.cat,grader:card.grader,grade:card.grade,market:card.market,paid,qty:1,portfolio:S.pendingPortfolio,lang:card.lang||null});
  S.pendingAddCard=null; renderCollection(); closeModal('addPortfolioModal'); showToast('Added to collection!','📚');
}
function createPortfolio() {
  const name = document.getElementById('newPortName').value.trim();
  if (!name) { showToast('Enter a portfolio name','⚠️','err'); return; }
  if (S.collection.portfolios.find(p=>p.name===name)) { showToast('Portfolio already exists','⚠️','err'); return; }
  const id = 'cp'+Date.now();
  S.collection.portfolios.push({id,name,listed:false});
  S.collection.activePortfolioId = id;
  closeModal('newPortfolioModal');
  document.getElementById('newPortName').value = '';
  renderCollection(); showToast(`Portfolio "${name}" created`,'✓');
}
function confirmDeletePortfolio(portId) {
  const p = S.collection.portfolios.find(p=>p.id===portId); if (!p) return;
  const cnt = S.collection.cards.filter(c=>c.portfolio===portId).length;
  document.getElementById('confirmTitle').textContent = `Delete "${p.name}"?`;
  document.getElementById('confirmMsg').textContent   = `This will remove the portfolio and all ${cnt} cards. Cannot be undone.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    S.collection.portfolios = S.collection.portfolios.filter(p=>p.id!==portId);
    S.collection.cards      = S.collection.cards.filter(c=>c.portfolio!==portId);
    if (S.collection.activePortfolioId===portId) S.collection.activePortfolioId=S.collection.portfolios[0]?.id||null;
    closeModal('confirmModal'); renderCollection(); showToast('Portfolio deleted','✓');
  };
  openModal('confirmModal');
}
function deleteCollCard(cardId) {
  S.collection.cards = S.collection.cards.filter(c=>c.id!==cardId);
  renderCollection(); showToast('Card removed','✓');
}

/* ══ ADD CARD MANUALLY ══ */
let _searchDebounce = null;
function debounceSearch() {
  clearTimeout(_searchDebounce);
  const q = document.getElementById('manualSearch').value.trim();
  const setQ = document.getElementById('manualSetSearch')?.value.trim() || '';
  if (!q && !setQ) { document.getElementById('searchResultList').innerHTML = ''; return; }
  if (!q) return;
  _searchDebounce = setTimeout(searchJustTCG, 320);
}
async function searchJustTCG() {
  const q = document.getElementById('manualSearch').value.trim(); if (!q) return;
  const setQ = (document.getElementById('manualSetSearch')?.value || '').trim();
  const list = document.getElementById('searchResultList');
  list.innerHTML = `<div style="text-align:center;padding:.75rem;font-size:.78rem;color:var(--muted);">🔍 Searching…</div>`;

  let results = [];

  try {
    let qStr = `name:"${q}"`;
    if (setQ) qStr += ` set.name:"${setQ}"`;
    const res = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(qStr)}&select=id,name,set,number,images,tcgplayer&orderBy=-set.releaseDate&pageSize=20`,
      { signal: AbortSignal.timeout(6000) }
    );
    const data = await res.json();
    if (data.data?.length) {
      results = data.data.map(c => {
        const prices = c.tcgplayer?.prices || {};
        const mkt = prices.holofoil?.market || prices['1stEditionHolofoil']?.market
          || prices.reverseHolofoil?.market || prices.normal?.market || 0;
        return {
          id: c.id, name: c.name,
          set: c.set?.name || '',
          game: 'pokemon',
          market: mkt,
          num: c.number ? `${c.number}/${c.set?.printedTotal||'?'}` : '',
          cat: 'raw',
          imageUrl: c.images?.small || null,
        };
      });
    }
  } catch {}

  const apiNames = new Set(results.map(r => r.name.toLowerCase()+'::'+r.set.toLowerCase()));
  const localSeen = new Set();
  const local = [...S.store.cards, ...S.collection.cards].filter(c => {
    const key = c.name.toLowerCase()+'::'+c.set.toLowerCase();
    if (apiNames.has(key) || localSeen.has(key)) return false;
    localSeen.add(key);
    const ql = q.toLowerCase();
    const setMatch = !setQ || c.set.toLowerCase().includes(setQ.toLowerCase());
    return c.name.toLowerCase().includes(ql) && setMatch;
  }).slice(0, 5).map(c => ({id:c.id,name:c.name,set:c.set,game:c.game,market:c.market,num:c.num,cat:c.cat,imageUrl:null}));

  results = [...results, ...local].slice(0, 15);

  const esc = s => s.replace(/'/g, "\\'");
  if (!results.length) {
    list.innerHTML = `<div style="text-align:center;padding:.75rem;font-size:.78rem;color:var(--muted);">No results for "${q}"${setQ?' in "'+setQ+'"':''}</div>
      <div class="sr-item" onclick="selectCustomCard('${esc(q)}')"><span>✏️ Add "${q}" as custom card</span></div>`;
    return;
  }

  window._searchResults = results;
  list.innerHTML = results.map((r, i) => {
    const thumb = r.imageUrl
      ? `<img src="${r.imageUrl}" alt="${r.name}" style="width:36px;height:50px;object-fit:cover;border-radius:4px;flex-shrink:0;">`
      : `<span style="font-size:1.2rem;width:36px;text-align:center;flex-shrink:0;">${r.game==='pokemon'?'⚡':'⚓'}</span>`;
    return `<div class="sr-item" style="gap:.6rem;align-items:center;" onclick="selectSearchCard(window._searchResults[${i}])">
      ${thumb}
      <span style="flex:1;min-width:0;"><strong>${r.name}</strong><br><span style="font-size:.7rem;color:var(--muted);">${r.set}${r.num?' · '+r.num:''}</span></span>
      <span class="sr-price">${r.market?fmt(r.market):'—'}</span></div>`;
  }).join('') + `<div class="sr-item" onclick="selectCustomCard('${esc(q)}')"><span>✏️ Add "${q}" as custom card</span></div>`;
}
function openAddCardModal() {
  S.manualCard=null;
  document.getElementById('manualSearch').value='';
  const setEl = document.getElementById('manualSetSearch'); if(setEl) setEl.value='';
  document.getElementById('searchResultList').innerHTML='';
  document.getElementById('manualFormArea').style.display='none';
  const setRow=document.getElementById('mSetRow'); if(setRow) setRow.remove();
  const sel=document.getElementById('mPortfolio');
  if (sel) sel.innerHTML=S.collection.portfolios.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  openModal('addCardModal');
}
function selectCustomCard(name) {
  S.manualCard={name,set:'',game:'pokemon',market:0,num:'',cat:'raw',id:null};
  document.getElementById('searchResultList').innerHTML='';
  document.getElementById('selectedCardPreview').innerHTML=`<strong>✏️ ${name}</strong> — fill in details below`;
  document.getElementById('manualFormArea').style.display='';
  let setRow=document.getElementById('mSetRow');
  if(!setRow){setRow=document.createElement('div');setRow.id='mSetRow';setRow.className='f-row';setRow.style.cssText='margin-bottom:0;grid-column:span 2;';setRow.innerHTML='<label>Set Name</label><input class="f-input" type="text" id="mSetName" placeholder="e.g. Obsidian Flames">';const grid=document.querySelector('#manualFormArea .f-row')?.closest('div[style*="grid"]');if(grid)grid.insertBefore(setRow,grid.firstChild);}
  document.getElementById('mSetName').value='';
}
function selectSearchCard(card) {
  S.manualCard = card;
  const setRow = document.getElementById('mSetRow'); if(setRow) setRow.remove();
  document.getElementById('searchResultList').innerHTML='';
  const gameIcon = card.game==='onepiece' ? '⚓' : '⚡';
  const thumb = card.imageUrl
    ? `<img src="${card.imageUrl}" alt="${card.name}" style="height:60px;border-radius:5px;vertical-align:middle;margin-right:.5rem;">`
    : `${gameIcon} `;
  document.getElementById('selectedCardPreview').innerHTML =
    `${thumb}<strong>${card.name}</strong> · ${card.set}${card.num?' · '+card.num:''} · <span style="color:var(--red);font-weight:900;">${card.market?fmt(card.market):'Price unknown — enter manually'}</span>`;
  document.getElementById('manualFormArea').style.display='';
}
function confirmManualAdd() {
  if (!S.manualCard) return;
  const portId=document.getElementById('mPortfolio').value; if(!portId){showToast('Select a portfolio','⚠️','err');return;}
  const qty=parseInt(document.getElementById('mQty').value)||1;
  const paid=parseFloat(document.getElementById('mPaid').value)||S.manualCard.market||0;
  const cat=document.getElementById('mCat').value;
  const grader=document.getElementById('mGrader').value||null;
  const grade=parseFloat(document.getElementById('mGrade').value)||null;
  const setNameEl=document.getElementById('mSetName');
  const setName=setNameEl?(setNameEl.value.trim()||S.manualCard.set):S.manualCard.set;
  const isOP = /^OP\d{2}-/i.test(S.manualCard.num||'') || S.manualCard.game==='onepiece';
  const game = S.manualCard.id ? S.manualCard.game : (isOP ? 'onepiece' : 'pokemon');
  S.collection.cards.push({id:'cc'+Date.now(),name:S.manualCard.name,set:setName,num:S.manualCard.num||'',game,cat,grader,grade,market:S.manualCard.market||0,paid,qty,portfolio:portId,imageUrl:S.manualCard.imageUrl||null});
  S.manualCard=null;
  document.getElementById('manualFormArea').style.display='none';
  document.getElementById('manualSearch').value='';
  const setEl=document.getElementById('manualSetSearch'); if(setEl) setEl.value='';
  document.getElementById('searchResultList').innerHTML='';
  const setRowFinal=document.getElementById('mSetRow'); if(setRowFinal) setRowFinal.remove();
  closeModal('addCardModal'); renderCollection(); showToast('Card added to collection','📚');
}

/* ══ ADD CARD TO STORE (Seller) ══ */
function openAddCardToStoreModal() {
  if (S.role!=='seller'&&S.role!=='admin') { showToast('Sellers only','⚠️','err'); return; }
  ['storeAddName','storeAddSet','storeAddNum','storeAddMarket','storeAddGrade'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const qtyEl=document.getElementById('storeAddQty'); if(qtyEl) qtyEl.value='1';
  const folderSel=document.getElementById('storeAddFolder');
  if (folderSel) folderSel.innerHTML=S.store.folders.map(f=>`<option value="${f.id}">${f.name} (${f.game})</option>`).join('');
  openModal('addStoreCardModal');
}
function confirmAddStoreCard() {
  const name   = document.getElementById('storeAddName').value.trim();
  const set    = document.getElementById('storeAddSet').value.trim();
  const num    = document.getElementById('storeAddNum').value.trim()||null;
  const market = parseFloat(document.getElementById('storeAddMarket').value)||0;
  const qty    = parseInt(document.getElementById('storeAddQty').value)||1;
  const cat    = document.getElementById('storeAddCat').value;
  const grader = document.getElementById('storeAddGrader').value||null;
  const grade  = parseFloat(document.getElementById('storeAddGrade').value)||null;
  const game   = document.getElementById('storeAddGame').value;
  const folder = document.getElementById('storeAddFolder').value;
  if (!name)   { showToast('Card name required','⚠️','err'); return; }
  if (!market) { showToast('Enter a price','⚠️','err'); return; }
  if (!folder) { showToast('Select a portfolio','⚠️','err'); return; }
  S.store.cards.push({id:'sc'+Date.now(),name,set,num,game,cat,grader,grade,market,paid:market,qty,folder});
  renderAll(); renderSellDashboard(); closeModal('addStoreCardModal'); showToast(`${name} added to store`,'✅');
}

/* ══ SELL DASHBOARD ══ */
function renderSellDashboard() {
  if (!S.user||(S.role!=='admin'&&S.role!=='seller')) return;
  const enabled = S.store.folders.filter(f=>f.enabled);
  const listedCards = S.store.cards.filter(c=>enabled.find(f=>f.id===c.folder));
  const totalVal    = listedCards.reduce((s,c)=>s+calcPrice(c)*c.qty,0);
  document.getElementById('sell-stats').innerHTML = `
    <div class="sell-stat"><div class="ss-label">Listed Cards</div><div class="ss-val">${listedCards.length}</div></div>
    <div class="sell-stat"><div class="ss-label">Total Value</div><div class="ss-val" style="color:#15803D;">${fmt(totalVal,0)}</div></div>
    <div class="sell-stat"><div class="ss-label">Portfolios</div><div class="ss-val">${enabled.length}</div></div>
    <div class="sell-stat"><div class="ss-label">Orders</div><div class="ss-val">0</div></div>`;
  const portGrid = document.getElementById('sell-portfolios-grid');
  portGrid.innerHTML = S.store.folders.map(f=>{
    const cnt     = S.store.cards.filter(c=>c.folder===f.id).length;
    const gameColor = f.game==='pokemon'?'#FFF3CD':'#DBEAFE';
    const gameText  = f.game==='pokemon'?'#92400E':'#1E3A8A';
    return `<div class="sell-portfolio-card ${f.enabled?'listed':''}">
      <div class="spc-header">
        <div><div class="spc-name">${f.name}</div>
          <span class="spc-game-badge" style="background:${gameColor};color:${gameText}">${f.game==='pokemon'?'⚡ Pokémon':f.game==='onepiece'?'⚓ One Piece':'🌐 Mixed'}</span></div>
      </div>
      <div class="spc-meta">${cnt} cards</div>
      <div class="spc-listing-toggle ${f.enabled?'listed':''}" onclick="toggleFolder('${f.id}');renderSellDashboard()">
        <div class="ts-track ${f.enabled?'on':''}"><div class="ts-thumb"></div></div>
        ${f.enabled?'✅ Listed':'⏸ Hidden'}
      </div>
      <div class="markup-row">
        <label>Markup</label>
        <input class="markup-input" type="number" value="${f.premiumPct}" min="0" step="0.5" onchange="setFolderPct('${f.id}',this.value)">
        <span class="markup-unit">% +</span>
        <input class="markup-input" type="number" value="${f.premiumFlat||0}" min="0" step="0.01" onchange="setFolderFlat('${f.id}',this.value)">
      </div></div>`;
  }).join('');
  renderSellCards();
  const sel = document.getElementById('sell-fsel');
  if (sel) sel.innerHTML = '<option value="">All portfolios</option>'+S.store.folders.map(f=>`<option value="${f.id}">${f.name}</option>`).join('');
}
function renderSellCards() {
  const {search,folder} = S.ui.sell;
  let cards = S.store.cards.filter(c=>{
    if (folder&&c.folder!==folder) return false;
    if (search&&!c.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  document.getElementById('sell-cnt').textContent = cards.length+' items';
  document.getElementById('grid-sell').innerHTML  = cards.map(c=>renderTile(c,'sell')).join('')||emptyState();
}
function switchSellTab(tab, btn) {
  document.querySelectorAll('.sell-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  ['portfolios','cards','pricing','import'].forEach(t=>{
    document.getElementById('sell-tab-'+t).style.display=t===tab?'':'none';
  });
  S.ui.sell.activeTab=tab;
}
function doSellSearch(v)      { S.ui.sell.search=v; renderSellCards(); }
function doSellFolderFilter(v){ S.ui.sell.folder=v; renderSellCards(); }
function applyMyPricing()     { showToast('Pricing saved','✓'); }

/* ══ FOLDER TOGGLES ══ */
function toggleFolder(id) {
  const f=S.store.folders.find(f=>f.id===id); if(!f) return;
  f.enabled=!f.enabled; renderAll(); renderSellDashboard();
  showToast(f.enabled?`"${f.name}" listed`:`"${f.name}" hidden`,'✓');
}
function setFolderPct(id,val)  { const f=S.store.folders.find(f=>f.id===id); if(f){f.premiumPct=parseFloat(val)||0;renderAll();showToast('Markup updated','✓');} }
function setFolderFlat(id,val) { const f=S.store.folders.find(f=>f.id===id); if(f){f.premiumFlat=parseFloat(val)||0;renderAll();showToast('Flat markup updated','✓');} }

/* ══ ADMIN PANEL ══ */
function openAdmin() {
  if (S.role!=='admin') { showToast('Admin only','⚠️','err'); return; }
  document.getElementById('adminOverlay').classList.add('open');
  renderAdminFolderList(); renderJTCGStatus(); renderUserTable();
}
function closeAdmin() { document.getElementById('adminOverlay').classList.remove('open'); }
function maybeCloseAdmin(e) { if(e.target===document.getElementById('adminOverlay')) closeAdmin(); }
function switchAdminTab(tab,btn) {
  document.querySelectorAll('.admin-tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.admin-tab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById('atab-'+tab).classList.add('active');
  S.ui.adminTab=tab;
  if(tab==='portfolios') renderAdminFolderList();
  if(tab==='users') renderUserTable();
  if(tab==='api') renderJTCGStatus();
}
function applyGlobal() {
  const g=S.store.global;
  g.pokePct=parseFloat(document.getElementById('gPokePct').value)||0;
  g.pokeFlat=parseFloat(document.getElementById('gPokeFlat').value)||0;
  g.opPct=parseFloat(document.getElementById('gOpPct').value)||0;
  g.opFlat=parseFloat(document.getElementById('gOpFlat').value)||0;
  renderAll(); showToast('Global pricing applied','✓');
}
function renderAdminFolderList() {
  document.getElementById('adminFolderList').innerHTML=S.store.folders.map(f=>{
    const cnt=S.store.cards.filter(c=>c.folder===f.id).length;
    return `<div class="folder-item"><div class="fi-icon">${f.game==='pokemon'?'⚡':f.game==='onepiece'?'⚓':'🌐'}</div>
      <div class="fi-info"><div class="fi-name">${f.name}</div><div class="fi-meta">${cnt} cards · ${f.game}</div></div>
      <input class="a-input" type="number" value="${f.premiumPct}" min="0" step="0.5" style="width:52px;padding:.25rem .3rem;font-size:.72rem;" onchange="setFolderPct('${f.id}',this.value)">
      <span class="punit">%</span>
      <button class="fi-toggle ${f.enabled?'on':''}" onclick="toggleFolder('${f.id}');renderAdminFolderList()">
        <div class="fi-toggle-dot"></div>${f.enabled?'Listed':'Hidden'}</button></div>`;
  }).join('');
}
function renderJTCGStatus() {
  const el=document.getElementById('jtcgStatusDisplay'); if(!el) return;
  el.innerHTML=CONFIG.justTcg.connected
    ?`<div class="jtcg-status connected"><div class="jtcg-dot"></div> Connected to JustTCG API</div>`
    :`<div class="jtcg-status disconnected"><div class="jtcg-dot"></div> Not connected — using simulated data</div>`;
}
function connectJustTCG() {
  const key=document.getElementById('jtcgApiKey').value.trim();
  if(!key){showToast('Enter an API key','⚠️','err');return;}
  CONFIG.justTcg.apiKey=key; CONFIG.justTcg.connected=true;
  renderJTCGStatus(); showToast('JustTCG connected','✓');
}
function testJustTCG() { showToast('Mock mode active — enter API key for live data','ℹ️'); }
function renderUserTable() {
  const tbody=document.getElementById('userTableBody'); if(!tbody) return;
  tbody.innerHTML=SIM_USERS.map(u=>`<tr>
    <td style="font-weight:800;font-size:.82rem;">${u.name}</td>
    <td style="color:var(--muted);font-size:.72rem;">${u.email}</td>
    <td><select class="role-select" onchange="changeUserRole('${u.email}',this.value)">
      <option ${u.role==='user'  ?'selected':''} value="user">User</option>
      <option ${u.role==='seller'?'selected':''} value="seller">Seller</option>
      <option ${u.role==='admin' ?'selected':''} value="admin">Admin</option>
    </select></td>
    <td><span class="demo-role-badge role-${u.role}">${u.role}</span></td></tr>`).join('');
}
function changeUserRole(email,role) {
  const u=SIM_USERS.find(u=>u.email===email);
  if(u){u.role=role;renderUserTable();showToast(`Role updated`,'✓');}
}

/* ══ CSV ══ */
function parseCSVRow(row) {
  const result=[]; let cur='',inQ=false;
  for(let i=0;i<row.length;i++){const ch=row[i];if(ch==='"'){inQ=!inQ;}else if(ch===','&&!inQ){result.push(cur.trim());cur='';}else{cur+=ch;}}
  result.push(cur.trim()); return result;
}
function handleCSV(evt,target) {
  const file=evt.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const lines=e.target.result.split(/\r?\n/).filter(l=>l.trim());
      const rawHdrs=parseCSVRow(lines[0]);
      const hdrs=rawHdrs.map(h=>h.toLowerCase().replace(/['"]/g,'').trim());
      const idx=k=>hdrs.findIndex(h=>h.includes(k));
      const nameI=idx('card name')>=0?idx('card name'):idx('name');
      const setI=idx('set name')>=0?idx('set name'):idx('set');
      const numI=idx('card number')>=0?idx('card number'):idx('number');
      const typeI=idx('type');const graderI=idx('grading company')>=0?idx('grading company'):idx('grader');
      const gradeI=idx('grade');const qtyI=idx('quantity')>=0?idx('quantity'):idx('qty');
      const paidI=idx('purchase price')>=0?idx('purchase price'):idx('paid');
      const priceI=idx('market price')>=0?idx('market price'):idx('market');
      const gameI=idx('game')>=0?idx('game'):idx('tcg');
      const portI=idx('portfolio')>=0?idx('portfolio'):idx('folder');
      const langI=idx('language')>=0?idx('language'):idx('lang');
      let portMap={},count=0;
      for(let i=1;i<lines.length;i++){
        const cols=parseCSVRow(lines[i]); if(cols.length<3) continue;
        const name=(nameI>=0?cols[nameI]:'').replace(/"/g,'').trim();
        if(!name||name.toLowerCase()===hdrs[nameI]) continue;
        const set=setI>=0?(cols[setI]||'').replace(/"/g,'').trim():'Unknown Set';
        const num=numI>=0?(cols[numI]||'').replace(/"/g,'').trim()||null:null;
        const typeRaw=typeI>=0?(cols[typeI]||'').toLowerCase():'';
        const graderRaw=graderI>=0?(cols[graderI]||'').replace(/"/g,'').trim().toUpperCase():'';
        const grade=gradeI>=0?parseFloat(cols[gradeI])||null:null;
        const qty=qtyI>=0?parseInt(cols[qtyI])||1:1;
        const paid=paidI>=0?parseFloat((cols[paidI]||'0').replace(/[$,]/g,''))||0:0;
        const market=priceI>=0?parseFloat((cols[priceI]||'0').replace(/[$,]/g,''))||0:paid;
        const gameRaw=gameI>=0?(cols[gameI]||'').toLowerCase().replace(/"/g,''):'';
        const portName=portI>=0?(cols[portI]||'').replace(/"/g,'').trim():'Imported';
        const langRaw=langI>=0?(cols[langI]||'').replace(/"/g,'').trim():'';
        const game=gameRaw.includes('one')||gameRaw.includes('op')?'onepiece':'pokemon';
        const lang=langRaw.toLowerCase().includes('jap')||langRaw.toLowerCase().includes('jpn')?'Japanese':null;
        let cat='raw';
        if(typeRaw.includes('seal')||typeRaw.includes('box')||typeRaw.includes('etb')) cat='sealed';
        else if(typeRaw.includes('case')) cat='case';
        else if(graderRaw&&['PSA','CGC','BGS','TAG'].some(g=>graderRaw.includes(g))) cat='slab';
        const grader=graderRaw.includes('BECKETT')?'BGS':(graderRaw||null);
        if(target==='store'){
          const fKey=portName+'::'+game;
          if(!portMap[fKey]){const fid='fi'+Date.now()+Object.keys(portMap).length;portMap[fKey]=fid;S.store.folders.push({id:fid,name:portName,game,enabled:true,premiumPct:5,premiumFlat:0});}
          S.store.cards.push({id:'ci'+Date.now()+count,name,set,num,game,cat,grader,grade,market,paid,qty,folder:portMap[fKey],lang});
        } else {
          const pid=portMap[portName]||(()=>{const id='cp'+Date.now()+Object.keys(portMap).length;portMap[portName]=id;if(!S.collection.portfolios.find(p=>p.name===portName))S.collection.portfolios.push({id,name:portName,game,listed:false});else portMap[portName]=S.collection.portfolios.find(p=>p.name===portName).id;return portMap[portName];})();
          S.collection.cards.push({id:'cc'+Date.now()+count,name,set,num,game,cat,grader,grade,market,paid,qty,portfolio:pid,lang});
        }
        count++;
      }
      if(target==='store'){renderAll();renderSellDashboard();}
      else{if(!S.collection.activePortfolioId&&S.collection.portfolios.length)S.collection.activePortfolioId=S.collection.portfolios[0].id;renderCollection();}
      showToast(`Imported ${count} cards`,'✓');
    }catch(err){console.error(err);showToast('CSV parse error','⚠️','err');}
    evt.target.value='';
  };
  reader.readAsText(file);
}
function exportCSV(type) {
  const esc=v=>`"${(v||'').toString().replace(/"/g,'""')}"`;
  let rows,filename;
  if(type==='store'){
    rows=['Card Name,Set Name,Card Number,Type,Grading Company,Grade,Quantity,Purchase Price,Market Price,Notes,Game,Portfolio,Language',...S.store.cards.map(c=>{const f=S.store.folders.find(f=>f.id===c.folder);return[esc(c.name),esc(c.set),esc(c.num||''),esc(c.cat),esc(c.grader||''),c.grade||'',c.qty,c.paid||0,c.market,'',esc(c.game),esc(f?.name||''),esc(c.lang||'')].join(',');})];
    filename='tcgpeaks-store.csv';
  } else {
    rows=['Card Name,Set Name,Card Number,Type,Grading Company,Grade,Quantity,Purchase Price,Market Price,Notes,Game,Portfolio,Language',...S.collection.cards.map(c=>{const p=S.collection.portfolios.find(p=>p.id===c.portfolio);return[esc(c.name),esc(c.set),esc(c.num||''),esc(c.cat),esc(c.grader||''),c.grade||'',c.qty,c.paid||0,c.market,'',esc(c.game),esc(p?.name||''),esc(c.lang||'')].join(',');})];
    filename='my-collection.csv';
  }
  const blob=new Blob([rows.join('\n')],{type:'text/csv'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();
  showToast('CSV exported','⬇');
}
function loadDemo() { S.store.folders=JSON.parse(JSON.stringify(DEMO_FOLDERS));S.store.cards=JSON.parse(JSON.stringify(DEMO_CARDS));renderAll();renderSellDashboard();showToast('Demo data reloaded','⚡'); }
function clearAll()  { S.store.cards=[];S.store.folders=[];renderAll();renderSellDashboard();showToast('Cleared','ℹ️'); }

/* ══ SETTINGS MODAL ══ */
function openSettings() {
  const el = document.getElementById('settingsModal');
  if (el) { el.classList.add('open'); if (window.Currency) window.Currency.syncUI(); }
}
