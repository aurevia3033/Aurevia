"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import dynamic from "next/dynamic";
import Nav from "@/components/Nav";
import { useLocale } from "@/lib/i18n-context";
import {TIMEFRAMES,getMarketAssetForTradingSymbol,isExternalMarketDataSource,type MarketQuote,type TimeframeId} from "@/lib/live-market";
import {normalizeDemoTradeCandles} from "@/lib/demo-trade-chart";
import {createQuoteOnlyCandle} from "@/lib/chart-candles";
import {MINIMUM_ORDER_NOTIONAL_USD} from "@/lib/trade-constants";
import { useTradingStore } from "@/lib/store";
import { io, type Socket } from "socket.io-client";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import "./trade-polish.css";
const LivePriceChart=dynamic(()=>import("@/components/LivePriceChart"),{
  loading:()=><div className="trade-chart-loading" role="status">Preparing market chart…</div>,
});
type I = { id: string; symbol: string; price: number; internalPrice?:number; internalUpdatedAt?:string; baseAsset?:string; quoteAsset?:string; change?: number; takerFee?: number; leverage?: number; updatedAt?:string; lastUpdatedAt?:string; assetId?:string; assetType?:string; source?:string; bid?:number|null; ask?:number|null; liveQuote?:MarketQuote };
type NumericValue=number|string;
type Order = {
  id: string;
  status: string;
  side: string;
  type: string;
  quantity: number;
  filledQuantity: number;
  price?: number;
  stopPrice?: number;
  instrument: { symbol: string };
};
type Pos = {
  id: string;
  instrumentId:string;
  side: string;
  quantity: number;
  entryPrice: number;
  margin: number;
  requiresSellOrder:boolean;
  instrument: { symbol: string; price: number;updatedAt:string };
};
type PositionResponse=Omit<Pos,"quantity"|"entryPrice"|"margin"|"instrument">&{
  quantity:NumericValue;
  entryPrice:NumericValue;
  margin:NumericValue;
  instrument:{symbol:string;price:NumericValue;updatedAt:string};
};
type PortfolioResponse={cashBalance:NumericValue};
type WalletResponse={accountMode:"DEMO"|"REAL";balances?:Array<{currency:string;availableBalance?:NumericValue;reservedBalance?:NumericValue}>};
type OrderBookLevel={price:number;quantity:number};
type OrderBook={kind?:"SIMULATED_BOOK"|"TOP_OF_BOOK";bids?:OrderBookLevel[];asks?:OrderBookLevel[];symbol?:string;last?:number;bid?:number|null;ask?:number|null;spread?:number|null;change?:number;changePercent?:number;marketStatus?:'OPEN'|'CLOSED'|'PREMARKET'|'AFTER_HOURS'|'UNKNOWN';source?:string;updatedAt?:string;depthAvailable?:false;error?:string};
type LiveQuotesResponse={quotes:Array<MarketQuote|{asset:MarketQuote['asset'];error:string}>};
type MarketUpdate={symbol:string;price:number;change:number;changePercent:number;source:string;dataMode:'SIMULATED'|'LIVE';lastUpdatedAt:string};
type TradeMessage={text:string;kind:'error'|'success'|'info'};
const LIVE_TRADE_ASSET_IDS=["BTC","AAPL","MSFT","NVDA","AMZN","GOOGL","TSLA","DJI","SPX","NASDAQ"];
const DEMO_CANDLE_RANGES:Record<TimeframeId,string>={ "1m":"1d","5m":"5d","15m":"1m","30m":"3m","1h":"1y","4h":"1y","1d":"max","1w":"max","1mo":"max",ytd:"max","1y":"max","5y":"max"};

function normalizedSymbol(value:string){return value.toUpperCase().replace(/[^A-Z0-9]/g,"")}
function isFailedOrder(order:Order){return order.status==='REJECTED'||order.status==='FAILED'}

async function loadTradingMarkets(mode:"DEMO"|"REAL",initialInstrumentResponse?:Response):Promise<I[]>{
  const [instrumentResponse,quoteResponse]=await Promise.all([
    initialInstrumentResponse?Promise.resolve(initialInstrumentResponse):fetch("/api/market",{cache:"no-store"}),
    mode==="REAL"
      ?fetch(`/api/live-markets?symbols=${LIVE_TRADE_ASSET_IDS.join(",")}`,{cache:"no-store"}).catch(()=>null)
      :Promise.resolve(null),
  ]);
  if(!instrumentResponse.ok)throw new Error("Unable to load trading instruments.");
  const instruments=await instrumentResponse.json() as I[];
  if(mode==="DEMO")return instruments.map(item=>({...item,price:Number(item.price),updatedAt:item.lastUpdatedAt||item.updatedAt}));

  let quotes:Array<MarketQuote|{asset:MarketQuote['asset'];error:string}>=[];
  if(quoteResponse?.ok){
    try{
      const payload=await quoteResponse.json() as LiveQuotesResponse;
      quotes=payload.quotes??[];
    }catch{}
  }
  const availableQuotes=quotes.filter((quote):quote is MarketQuote=>{
    if(!("price"in quote)||!Number.isFinite(quote.price)||quote.isStale||!isExternalMarketDataSource(quote.source))return false;
    const age=Date.now()-Date.parse(quote.updatedAt);
    return age<=30_000&&age>=-5_000;
  });
  return instruments.flatMap(instrument=>{
    const internalPrice=Number(instrument.price);
    const internalUpdatedAt=instrument.lastUpdatedAt||instrument.updatedAt;
    const internalFields={internalPrice,internalUpdatedAt,baseAsset:instrument.baseAsset,quoteAsset:instrument.quoteAsset};
    const symbol=normalizedSymbol(instrument.symbol);
    const quote=availableQuotes.find(item=>
      symbol===normalizedSymbol(item.asset.id)||
      symbol===normalizedSymbol(item.asset.ticker)||
      item.asset.id==="BTC"&&symbol==="BTCUSD",
    );
    if(!quote||!['STOCK','CRYPTO'].includes(quote.asset.type)){
      const supportedAsset=getMarketAssetForTradingSymbol(instrument.symbol);
      return supportedAsset?[{
        ...instrument,
        ...internalFields,
        price:Number(instrument.price),
        updatedAt:internalUpdatedAt,
        assetId:supportedAsset.id,
        assetType:supportedAsset.type,
      }]:[];
    }
    return [{
      ...instrument,
      ...internalFields,
      price:quote.price,
      change:quote.changePercent,
      updatedAt:quote.updatedAt,
      lastUpdatedAt:quote.updatedAt,
      assetId:quote.asset.id,
      assetType:quote.asset.type,
      source:quote.source,
      bid:quote.bid,
      ask:quote.ask,
      liveQuote:quote,
    }];
  });
}

export default function Trade() {
  const { translate } = useLocale();
  const {data:session,status:sessionStatus}=useSession();
  const [items, setItems] = useState<I[]>([]);
  const updateStore = useTradingStore((s) => s.updatePrices);
  const [selected, setSelected] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [type, setType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [orderAmount, setOrderAmount] = useState(String(MINIMUM_ORDER_NOTIONAL_USD));
  const [price, setPrice] = useState("");
  const [message,setMessage]=useState<TradeMessage|null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [dismissedFailedOrderIds,setDismissedFailedOrderIds]=useState<string[]>([]);
  const [dismissedChartError,setDismissedChartError]=useState(false);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [book, setBook] = useState<OrderBook>({ bids: [], asks: [] });
  const [availableBalance, setAvailableBalance] = useState<number | null>(null);
  const [walletBalances,setWalletBalances]=useState<WalletResponse["balances"]>([]);
  const [clock,setClock]=useState(0);
  const [accountMode, setAccountMode] = useState<'DEMO'|'REAL'|'LOADING'>(session?.user?.accountMode||'LOADING');
  const [placing, setPlacing] = useState(false);
  const [chartTimeframe,setChartTimeframe]=useState<TimeframeId>("1m");
  const [liveCandles,setLiveCandles]=useState<Array<{time:number;open:number;high:number;low:number;close:number;volume:number|null}>>([]);
  const [chartSource,setChartSource]=useState<string>();
  const [demoChartQuote,setDemoChartQuote]=useState<MarketQuote>();
  const [chartLoading,setChartLoading]=useState(false);
  const [chartError,setChartError]=useState("");
  const [chartQuoteOnly,setChartQuoteOnly]=useState(false);
  const providerHistoryLoaded=useRef(false);
  const currentLiveQuote=useRef<MarketQuote|undefined>(undefined);
  const currentChartPrice=useRef<number|undefined>(undefined);
  useEffect(()=>{
    const refresh=()=>setClock(Date.now());
    refresh();
    const timer=window.setInterval(refresh,1_000);
    return()=>window.clearInterval(timer);
  },[]);
  useEffect(()=>{
    if(!session?.user?.id||(accountMode!=="DEMO"&&accountMode!=="REAL")){
      setDismissedFailedOrderIds([]);
      return;
    }
    const storageKey=`aurevia.dismissed-trade-orders.v1:${session.user.id}:${accountMode}`;
    try{
      const stored=localStorage.getItem(storageKey);
      const parsed=stored?JSON.parse(stored):[];
      setDismissedFailedOrderIds(Array.isArray(parsed)?parsed.filter((id):id is string=>typeof id==='string'):[]);
    }catch(error){
      console.warn('Unable to restore dismissed failed-order preferences.',error instanceof Error?error.name:'UnknownError');
      setDismissedFailedOrderIds([]);
    }
  },[accountMode,session?.user?.id]);

  useEffect(()=>{setDismissedChartError(false)},[chartError]);

  useEffect(() => {
    if(sessionStatus!=='authenticated')return;
    let active = true;
    let activeMode=session?.user?.accountMode;
    if(activeMode)setAccountMode(activeMode);
    setAvailableBalance(null);
    setOrders([]);
    setPositions([]);
    setItems([]);
    setSelected("");
    setMessage(null);
    const marketPromise=fetch("/api/market",{cache:"no-store"})
      .then(response=>loadTradingMarkets(activeMode||"DEMO",response))
      .then(market=>{
        if(!active)return;
        setItems(market);
        setSelected(current=>market.some(item=>item.id===current)?current:market[0]?.id||"");
        if(activeMode==="REAL"&&!market.length)setMessage({text:"Current market quotes are unavailable. Refresh to try again.",kind:'info'});
      })
      .catch(()=>{
        if(active)setMessage({text:activeMode==="REAL"?"Market quotes could not load. Refresh to try again.":"Trading data could not load. Refresh to retry.",kind:'error'});
      });
    const load = async () => {
      try {
        const [orderResponse,positionResponse,portfolioResponse,currencyWalletResponse] = await Promise.all([
          fetch("/api/orders"),
          fetch("/api/positions"),
          fetch("/api/portfolio"),
          fetch("/api/wallet",{cache:"no-store"}),
        ]);
        if ([orderResponse,positionResponse,portfolioResponse,currencyWalletResponse].some((response) => !response.ok))
          throw new Error("Unable to load trading data.");
        const portfolioData=await portfolioResponse.json() as PortfolioResponse;
        const currencyWalletData=await currencyWalletResponse.json() as WalletResponse;
        activeMode=currencyWalletData.accountMode;
        if(activeMode!==(session?.user?.accountMode)){
          setAccountMode(activeMode);
          void marketPromise.then(()=>loadTradingMarkets(activeMode!)).then(market=>{
            if(!active)return;
            setItems(market);
            setSelected(current=>market.some(item=>item.id===current)?current:market[0]?.id||"");
          }).catch(()=>{if(active)setMessage({text:"Market quotes could not load. Refresh to try again.",kind:'error'})});
        }else setAccountMode(currencyWalletData.accountMode);
        const [orderData,positionData]=await Promise.all([
          orderResponse.json() as Promise<Order[]>,
          positionResponse.json() as Promise<PositionResponse[]>,
        ]);
        if (!active) return;
        setOrders(orderData);
        setAccountMode(currencyWalletData.accountMode);
        setAvailableBalance(Number(portfolioData.cashBalance));
        setWalletBalances(currencyWalletData.balances||[]);
        setPositions(
          positionData.map((position) => ({
            ...position,
            quantity: Number(position.quantity),
            entryPrice: Number(position.entryPrice),
            margin: Number(position.margin),
            instrument: {
              ...position.instrument,
              price: Number(position.instrument.price),
            },
          })),
        );
      } catch {
        if (active){
          if(activeMode==="REAL"){
            setMessage({text:"Market quotes could not load. Refresh to try again.",kind:'error'});
          }else setMessage({text:"Trading data could not load. Refresh to retry.",kind:'error'});
        }
      }
    };
    void load();
    const refreshPrices=async()=>{
      if(!activeMode)return;
      try{
        const market=await loadTradingMarkets(activeMode);
        if(!active)return;
        setItems(market);
        setSelected(current=>market.some(item=>item.id===current)?current:market[0]?.id||"");
        if(activeMode==="DEMO")updateStore(market);
        if(activeMode==="REAL"&&!market.length)setMessage({text:"Current market quotes are unavailable. Refresh to try again.",kind:'info'});
        else setMessage(current=>current?.text.startsWith("Current market quotes")||current?.text.startsWith("Market quotes")?null:current);
      }catch{
        if(active&&activeMode==="REAL"){
          setMessage({text:"Market quotes could not refresh. Try again.",kind:'error'});
        }
      }
    };
    const timer=window.setInterval(()=>void refreshPrices(),3_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [updateStore,sessionStatus,session?.user?.accountMode]);
  useEffect(()=>{
    if(accountMode!=="REAL"&&accountMode!=="DEMO"){
      return;
    }
    const socket:Socket=io({path:"/socket.io",transports:["websocket"],autoConnect:true,reconnection:true,reconnectionDelay:700});
    const onMarketUpdate=(updates:MarketUpdate[])=>{
      setItems(current=>current.map(item=>{
        const update=updates.find(entry=>
          entry.symbol===(item.assetId||item.symbol)&&Number.isFinite(entry.price)&&(
            accountMode==="DEMO"
              ?entry.dataMode==="SIMULATED"
              :entry.dataMode==="LIVE"&&isExternalMarketDataSource(entry.source)
          ),
        );
        if(!update)return item;
        if(accountMode==="DEMO")return {...item,price:update.price,change:update.change,updatedAt:update.lastUpdatedAt,lastUpdatedAt:update.lastUpdatedAt};
        if(!item.liveQuote)return item;
        const liveQuote={...item.liveQuote,price:update.price,change:update.change,changePercent:update.changePercent,source:update.source,updatedAt:update.lastUpdatedAt,isStale:false};
        return {...item,price:update.price,change:update.changePercent,updatedAt:update.lastUpdatedAt,lastUpdatedAt:update.lastUpdatedAt,source:update.source,liveQuote};
      }));
      if(accountMode==="DEMO")updateStore(updates.filter(update=>update.dataMode==="SIMULATED").map(({symbol,price,change})=>({symbol,price,change})));
    };
    socket.on("market:update",onMarketUpdate);
    return()=>{socket.off("market:update",onMarketUpdate);socket.disconnect();};
  },[accountMode,updateStore]);
  useEffect(() => {
    if(!selected||!['DEMO','REAL'].includes(accountMode))return;
    let active=true;
    const load=async()=>{
      try{
        const response=await fetch(`/api/orderbook?instrumentId=${encodeURIComponent(selected)}`,{cache:'no-store'});
        const result=await response.json() as OrderBook;
        if(!active)return;
        setBook(response.ok?result:{kind:accountMode==='REAL'?'TOP_OF_BOOK':'SIMULATED_BOOK',error:result.error||'Market data is unavailable.'});
      }catch{
        if(active)setBook({kind:accountMode==='REAL'?'TOP_OF_BOOK':'SIMULATED_BOOK',error:'Market data is temporarily unavailable.'});
      }
    };
    setBook({});
    void load();
    const t = setInterval(()=>void load(),accountMode==='REAL'?15_000:2500);
    return () => {active=false;clearInterval(t);};
  }, [selected,accountMode]);
  const cur = items.find((i) => i.id === selected);
  const chartAssetId=cur?.assetId||getMarketAssetForTradingSymbol(cur?.symbol||'')?.id;
  const demoMark=chartAssetId?undefined:cur?.price;
  const demoProviderQuote=demoChartQuote?.asset.id===chartAssetId?demoChartQuote:undefined;
  function selectInstrument(instrument:I){
    setSelected(instrument.id);
    if(accountMode==="REAL"&&instrument.assetType==="CRYPTO"&&type==="STOP"){
      setType("MARKET");
      setPrice("");
    }
  }
  const pnl = (p: Pos) => {
    const mark=items.find(item=>item.symbol===p.instrument.symbol);
    if(accountMode==="REAL"&&!mark?.liveQuote)return null;
    const price=mark?.price??(accountMode==="DEMO"?p.instrument.price:null);
    if(price===null)return null;
    return p.side==="BUY"?(price-p.entryPrice)*p.quantity:(p.entryPrice-price)*p.quantity;
  };
  useEffect(()=>{
    currentLiveQuote.current=cur?.liveQuote;
    currentChartPrice.current=cur?.price;
  },[cur?.liveQuote,cur?.price]);
  useEffect(()=>{
    if(!['DEMO','REAL'].includes(accountMode)||(!chartAssetId&&accountMode!=="DEMO")){
      setLiveCandles([]);
      setChartSource(undefined);
      setChartLoading(false);
      setChartError(selected?"Provider market history is unavailable for this instrument.":"");
      return;
    }
    let active=true;
    setLiveCandles([]);
    setChartSource(undefined);
    setChartQuoteOnly(false);
    providerHistoryLoaded.current=false;
    const loadHistory=async()=>{
      setChartLoading(true);
      setChartError("");
      const interval=TIMEFRAMES.find(item=>item.id===chartTimeframe)?.interval||"1m";
      const demoFallbackPrice=demoMark??currentChartPrice.current;
      if(accountMode==="DEMO"&&!chartAssetId&&!providerHistoryLoaded.current&&Number.isFinite(demoFallbackPrice)&&Number(demoFallbackPrice)>0){
        setLiveCandles(createQuoteOnlyCandle(Number(demoFallbackPrice),Date.now(),interval));
        setChartSource("Aurevia DEMO");
        setChartQuoteOnly(false);
      }
      try{
        let history:{candles:typeof liveCandles;source:string};
        if(!chartAssetId){
          if(!selected)return;
          const response=await fetch(`/api/candles?instrumentId=${encodeURIComponent(selected)}&range=${DEMO_CANDLE_RANGES[chartTimeframe]}&limit=500`,{cache:"no-store"});
          if(!response.ok)throw new Error("Simulated market candles are unavailable.");
          const rows=await response.json() as Array<{ts:string;open:number|string;high:number|string;low:number|string;close:number|string;volume:number|string|null}>;
          history={candles:normalizeDemoTradeCandles(rows,demoMark??NaN,Date.now(),interval),source:"Aurevia DEMO"};
        }else{
          const response=await fetch(`/api/live-markets/${encodeURIComponent(chartAssetId)}?timeframe=${chartTimeframe}`,{cache:"no-store"});
          const result=await response.json();
          if(!response.ok)throw new Error(typeof result.error==="string"?result.error:"Market chart data is unavailable.");
          const providerHistory=result as {candles:typeof liveCandles;source?:string};
          const external=!!providerHistory.source&&isExternalMarketDataSource(providerHistory.source);
          if(!providerHistory.source||!external||!Array.isArray(providerHistory.candles)||!providerHistory.candles.length)throw new Error("Market chart data is unavailable.");
          history={candles:providerHistory.candles,source:providerHistory.source};
        }
        if(active){
          providerHistoryLoaded.current=true;
          setLiveCandles(history.candles);
          setChartSource(history.source);
          setChartQuoteOnly(false);
        }
      }catch(error){
        if(active){
          const quote=currentLiveQuote.current;
          const quoteAge=quote?Date.now()-Date.parse(quote.updatedAt):Infinity;
          const quoteIsFresh=accountMode==="REAL"&&!!quote&&isExternalMarketDataSource(quote.source)&&
            !quote.isStale&&Number.isFinite(quote.price)&&quote.price>0&&quoteAge>=-5_000&&quoteAge<=30_000;
          if(!providerHistoryLoaded.current&&quoteIsFresh&&quote){
            setLiveCandles(createQuoteOnlyCandle(quote.price,Date.parse(quote.updatedAt),interval));
            setChartSource(quote.source);
            setChartQuoteOnly(true);
            setChartError("");
          }else setChartError(error instanceof Error?error.message:"Market chart data is unavailable.");
        }
      }finally{if(active)setChartLoading(false);}
    };
    void loadHistory();
    const timer=window.setInterval(()=>void loadHistory(),chartTimeframe==="1m"||chartTimeframe==="5m"?15_000:60_000);
    return()=>{active=false;window.clearInterval(timer);};
  },[accountMode,chartAssetId,chartTimeframe,selected,demoMark]);
  useEffect(()=>{
    if(accountMode!=="DEMO"||!chartAssetId){setDemoChartQuote(undefined);return}
    let active=true;
    const loadQuote=async()=>{
      try{
        const response=await fetch(`/api/live-markets?symbols=${encodeURIComponent(chartAssetId)}`,{cache:"no-store"});
        const result=await response.json() as {quotes?:Array<MarketQuote|{asset:MarketQuote['asset'];error:string}>};
        if(!response.ok)throw new Error("Provider market quote is unavailable.");
        const quote=result.quotes?.find(item=>"price"in item) as MarketQuote|undefined;
        const age=quote?Date.now()-Date.parse(quote.updatedAt):Infinity;
        if(!quote||!isExternalMarketDataSource(quote.source)||quote.isStale||age>5*60_000||age< -5_000)throw new Error("Provider market quote is unavailable.");
        if(active)setDemoChartQuote(quote);
      }catch{
        if(active)setDemoChartQuote(undefined);
      }
    };
    void loadQuote();
    const timer=window.setInterval(()=>void loadQuote(),3_000);
    return()=>{active=false;window.clearInterval(timer);};
  },[accountMode,chartAssetId]);
  const realReferencePrice=cur?.liveQuote?.price;
  const estimatedPrice=accountMode==="REAL"?realReferencePrice:cur?.price;
  const selectedBaseCurrency=(cur?.baseAsset||cur?.symbol.split('/')[0]||'').toUpperCase();
  const selectedQuoteCurrency=(cur?.quoteAsset||cur?.symbol.split('/')[1]||'USD').toUpperCase();
  const tradeWalletCurrency=side==="BUY"?selectedQuoteCurrency:selectedBaseCurrency;
  const tradeWalletBalance=walletBalances?.find(item=>item.currency.toUpperCase()===tradeWalletCurrency);
  const heldSellQuantity=positions.filter(position=>position.instrumentId===selected&&position.side==="BUY").reduce((total,position)=>total+position.quantity,0);
  const reservedSellQuantity=orders.filter(order=>order.instrument.symbol===cur?.symbol&&order.side==="SELL"&&["OPEN","PARTIALLY_FILLED","PENDING_CANCEL"].includes(order.status)).reduce((total,order)=>total+Math.max(0,order.quantity-order.filledQuantity),0);
  const availableSellQuantity=accountMode==="REAL"
    ?Number(tradeWalletBalance?.availableBalance??0)
    :Math.max(0,heldSellQuantity-reservedSellQuantity);
  const orderAmountUsd=Number(orderAmount);
  const rawQuantity=estimatedPrice&&estimatedPrice>0&&Number.isFinite(orderAmountUsd)?orderAmountUsd/estimatedPrice:0;
  const calculatedQuantity=rawQuantity>0?Math.ceil(rawQuantity*1e10)/1e10:0;
  const requestedQuantity=side==="SELL"?Math.min(calculatedQuantity,availableSellQuantity):calculatedQuantity;
  const estimatedNotional = (estimatedPrice ?? 0) * (Number.isFinite(requestedQuantity) ? requestedQuantity : 0);
  const estimatedFee = estimatedNotional * Number(cur?.takerFee ?? 0);
  const estimatedTradeValue=side==="BUY"?estimatedNotional+estimatedFee:Math.max(0,estimatedNotional-estimatedFee);
  const availableTradeBalance=accountMode==="REAL"?Number(tradeWalletBalance?.availableBalance??0):availableBalance;
  const reservedTradeBalance=Number(tradeWalletBalance?.reservedBalance??0);
  const internalQuoteAge=cur?.liveQuote?.updatedAt?clock-Date.parse(cur.liveQuote.updatedAt):Infinity;
  const realExecutionQuoteFresh=accountMode!=="REAL"||
    (Number.isFinite(realReferencePrice)&&Number(realReferencePrice)>0&&Number.isFinite(internalQuoteAge)&&internalQuoteAge>=-5_000&&internalQuoteAge<=30_000);
  const formatWalletAmount=(value:number|null|undefined,currency:string)=>{
    if(value===null||value===undefined||!Number.isFinite(value))return "—";
    if(["USD","EUR","GBP","JPY","CAD","AUD","CHF"].includes(currency)){
      try{return new Intl.NumberFormat(undefined,{style:"currency",currency,maximumFractionDigits:currency==="JPY"?0:2}).format(value)}catch{}
    }
    return `${new Intl.NumberFormat(undefined,{maximumFractionDigits:currency==="BTC"?8:10}).format(value)} ${currency}`;
  };
  const hiddenFailedOrderIds=new Set(dismissedFailedOrderIds);
  const failedOrders=orders.filter(isFailedOrder);
  const visibleFailedOrders=failedOrders.filter(order=>!hiddenFailedOrderIds.has(order.id));
  const visibleOrderHistory=orders.filter(order=>!hiddenFailedOrderIds.has(order.id));

  function clearFailedOrders(){
    const failedIds=visibleFailedOrders.map(order=>order.id);
    if(!failedIds.length)return;
    const next=[...new Set([...dismissedFailedOrderIds,...failedIds])];
    setDismissedFailedOrderIds(next);
    if(session?.user?.id&&(accountMode==="DEMO"||accountMode==="REAL")){
      try{
        localStorage.setItem(`aurevia.dismissed-trade-orders.v1:${session.user.id}:${accountMode}`,JSON.stringify(next));
      }catch(error){
        console.warn('Unable to save dismissed failed-order preferences.',error instanceof Error?error.name:'UnknownError');
      }
    }
    setMessage({text:'Failed orders cleared from this view. Your order history record is retained.',kind:'info'});
  }

  async function place(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (placing) return;
    if(!cur||!realExecutionQuoteFresh){
      setMessage({text:"A fresh Aurevia internal simulated price is required before submitting this order.",kind:'error'});
      return;
    }
    setPlacing(true);
    setMessage(null);
    const body = {
      instrumentId: selected,
      side,
      type,
      quantity: requestedQuantity,
      price: type === "LIMIT" && price ? Number(price) : undefined,
      stopPrice: type === "STOP" && price ? Number(price) : undefined,
      expectedPrice:accountMode==="REAL"?cur.liveQuote!.price:cur.price,
      observedAt:accountMode==="REAL"?cur.liveQuote!.updatedAt:cur.updatedAt,
    };
    let response:Response;
    try{
      response=await fetch("/api/orders",{
        method:"POST",
        headers:{"content-type":"application/json","Idempotency-Key":crypto.randomUUID()},
        body:JSON.stringify(body),
      });
    }catch{
      setMessage({text:"The order result could not be confirmed. Reload the page to check order history before trying again.",kind:'error'});
      setPlacing(false);
      return;
    }

    let result:Order&{error?:string};
    try{
      result=await response.json() as Order&{error?:string};
    }catch{
      setMessage({text:"The order was sent, but its result could not be confirmed. Reload the page to check order history before trying again.",kind:'error'});
      setPlacing(false);
      return;
    }
    if(!response.ok){
      setMessage({text:result.error||"Order failed",kind:'error'});
      setPlacing(false);
      return;
    }
    setMessage({text:`Order ${String(result.status||'submitted').replaceAll('_',' ').toLowerCase()}.`,kind:isFailedOrder(result)?'error':'success'});
    setOrders(current=>[result,...current]);
    try{
      const [positionResponse,portfolioResponse,currencyWalletResponse]=await Promise.all([fetch("/api/positions"),fetch("/api/portfolio"),fetch("/api/wallet",{cache:"no-store"})]);
      if(positionResponse.ok)setPositions((await positionResponse.json()).map((position:PositionResponse)=>({...position,quantity:Number(position.quantity),entryPrice:Number(position.entryPrice),margin:Number(position.margin),instrument:{...position.instrument,price:Number(position.instrument.price)}})));
      if(portfolioResponse.ok){
        const wallet=await portfolioResponse.json() as PortfolioResponse;
        setAvailableBalance(Number(wallet.cashBalance));
      }
      if(currencyWalletResponse.ok)setWalletBalances((await currencyWalletResponse.json() as WalletResponse).balances||[]);
    }catch{
      setMessage({text:"The order was accepted, but account balances could not be refreshed. Refresh the page before placing another order.",kind:'info'});
    }
    setPlacing(false);
  }
  async function cancel(id: string) {
    const r = await fetch("/api/orders", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: id }),
    });
    if (r.ok) {
      const updated=await r.json();
      setOrders((current)=>current.map((order)=>order.id===id?{...order,...(updated.id?updated:{status:"CANCELLED"})}:order));
      setMessage({text:'Order cancelled.',kind:'success'});
    } else {
      const result=await r.json();
      setMessage({text:result.error||"Unable to cancel order",kind:'error'});
    }
  }
  async function close(id: string) {
    const position=positions.find((item)=>item.id===id);
    if(!position)return;
    if(position.requiresSellOrder){
      setMessage({text:"This is a retained legacy provider-linked position and is not backed by a matching Aurevia Wallet asset. It cannot be closed as an internal simulated wallet order.",kind:'error'});
      return;
    }
    const r = await fetch("/api/positions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionId: id }),
    });
    const j = await r.json();
    setMessage({text:r.ok?"Position closed":j.error||"Close failed",kind:r.ok?'success':'error'});
    if (r.ok) setPositions((p) => p.filter((x) => x.id !== id));
  }
  return (
    <div data-section="trade">
      <Nav />
      <main className="trade-terminal trade-workspace">
        <header className="account-heading trade-page-heading"><div><span className="account-kicker">{accountMode==='LOADING'?translate('restoringAccountMode'):`${accountMode} ACCOUNT · ${translate('tradingWorkspace')}`}</span><h1>{translate('tradeMarkets')}</h1></div><span className={`status-pill ${accountMode==='REAL'?'mode-real':'mode-demo'}`}>{accountMode==='LOADING'?'RESTORING':accountMode==='REAL'?'REAL ONLY':'DEMO ACCOUNT'}</span></header>
        {(accountMode==='REAL'||accountMode==='DEMO')?<>
        <div className="trade-workspace-grid grid gap-4 xl:grid-cols-[1fr_340px]">
          <section className="trade-market-card card min-h-[650px] p-5">
            <div className="trade-market-select" role="group" aria-label={translate('selectAnInstrument')}>
              {items.map((i) => (
                <button
                  type="button"
                  key={i.id}
                  onClick={() => selectInstrument(i)}
                  className={`rounded-lg px-3 py-2 text-sm ${i.id === selected ? "bg-gold text-black" : "bg-white/5"}`}
                  aria-pressed={i.id === selected}
                  data-asset-type={i.assetType}
                >
                  {i.symbol}{" "}
                  {i.price.toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                </button>
              ))}
              {!items.length&&<p className="muted text-sm">{accountMode==="REAL"?"No instruments currently have a valid market quote. Refresh to check again.":"No trading instruments are available."}</p>}
            </div>
            <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_220px]">
              <div className="trade-chart-panel">
                <div className="trade-chart-header">
                  <div>
                    <span className="account-kicker">{cur?.symbol||translate('selectAnInstrument')}</span>
                    <p className="trade-last-price">{cur?.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:cur.price<10?4:2})||"—"}</p>
                    {accountMode==="REAL"&&cur?.liveQuote&&<span className="muted text-xs">Bid {cur.bid?.toLocaleString(undefined,{maximumFractionDigits:6})??"—"} · Ask {cur.ask?.toLocaleString(undefined,{maximumFractionDigits:6})??"—"}</span>}
                    {accountMode==="DEMO"&&chartAssetId&&<span className="muted text-xs" aria-live="polite">{demoProviderQuote?`External market reference · ${demoProviderQuote.source}: ${demoProviderQuote.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:demoProviderQuote.price<10?4:2})}`:"External market reference unavailable"} · not used for DEMO orders</span>}
                  </div>
                  <span className="status-pill">{accountMode==="REAL"?(cur?.liveQuote?"Market quote":"Quote unavailable"):translate('simulatedPrice')}</span>
                </div>
                <div className="hidden">
                  <div className="mb-2 text-4xl font-black">
                  {cur?.price.toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                  </div>
                </div>
                <div className="trade-live-chart">
                  <div className="trade-chart-timeframes" role="group" aria-label="Chart interval">
                    {TIMEFRAMES.map(item=><button type="button" key={item.id} aria-pressed={chartTimeframe===item.id} onClick={()=>setChartTimeframe(item.id)}>{item.label}</button>)}
                  </div>
                  {chartAssetId||accountMode==="DEMO"&&selected?
                    <LivePriceChart candles={liveCandles} quote={(accountMode==="REAL"?cur?.liveQuote:demoChartQuote)||undefined} timeframe={chartTimeframe} source={chartSource} loading={chartLoading} error={dismissedChartError?'':chartError} allowSimulatedHistory={accountMode==="DEMO"} quoteOnly={chartQuoteOnly}/>
                    :<div className="trade-chart-unavailable" role="status"><span>{chartError||"Provider market data is unavailable for this instrument."}</span></div>}
                </div>
              </div>
              <div className="trade-orderbook">
                <h3 className="font-bold">{accountMode==="REAL"?"Best bid and ask":translate('orderBook')} {accountMode==="DEMO"&&<small>{translate('demoFeedOnly')}</small>}</h3>
                {accountMode==="REAL"?
                  <div className="mt-3 space-y-3 text-xs">
                    <p className="muted">Best bid and ask only. Level 2 market depth is not provided.</p>
                    <div className="flex justify-between text-loss"><span>Best ask</span><b>{(book.ask===undefined?cur?.ask:book.ask)?.toLocaleString(undefined,{maximumFractionDigits:6})??"Unavailable"}</b></div>
                    <div className="flex justify-between text-profit"><span>Best bid</span><b>{(book.bid===undefined?cur?.bid:book.bid)?.toLocaleString(undefined,{maximumFractionDigits:6})??"Unavailable"}</b></div>
                    {book.error&&<div className="trade-inline-notice" role="status"><span>{book.error}</span><button type="button" aria-label="Dismiss market data notice" onClick={()=>setBook(current=>({...current,error:undefined}))}><X size={15}/></button></div>}
                  </div>
                  :<div className="mt-3 text-xs">
                  {book.asks
                    ?.slice()
                    .reverse()
                    .map((x) => (
                      <div
                        key={x.price}
                        className="flex justify-between text-loss"
                      >
                        <span>{x.price.toFixed(6)}</span>
                        <span>{x.quantity}</span>
                      </div>
                    ))}
                  <div className="my-2 border-t border-white/10" />
                  {book.bids?.map((x) => (
                    <div
                      key={x.price}
                      className="flex justify-between text-profit"
                    >
                      <span>{x.price.toFixed(6)}</span>
                      <span>{x.quantity}</span>
                    </div>
                  ))}
                </div>
                }
              </div>
            </div>
          </section>
          <section className="trade-ticket-card card p-5">
            <div className="account-panel-title"><div><h2>{translate('orderTicket')}</h2><p className="account-panel-subtitle">{accountMode==='REAL'?'Aurevia internal simulated execution':'DEMO practice order'}</p></div></div>
            <form onSubmit={place} className="space-y-3">
              <fieldset className="space-y-3">
              <div className="grid grid-cols-2 gap-2" role="group" aria-label={translate('orderSide')}>
              <button type="button" aria-pressed={side === "BUY"}
                onClick={() => setSide("BUY")}
                className={`btn ${side === "BUY" ? "bg-profit text-black" : "bg-white/5"}`}
              >
                {translate('buy')}
              </button>
              <button type="button" aria-pressed={side === "SELL"}
                onClick={() => {
                  setSide("SELL");
                  if(estimatedPrice&&availableSellQuantity>0)setOrderAmount((estimatedPrice*availableSellQuantity).toFixed(8));
                }}
                className={`btn ${side === "SELL" ? "bg-loss text-white" : "bg-white/5"}`}
              >
                {translate('sell')}
              </button>
            </div>
              <label className="account-label">{translate('orderType')}<select className="input" required value={type} onChange={(event) => setType(event.target.value as "MARKET"|"LIMIT"|"STOP")}><option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP" disabled={accountMode==="REAL"&&cur?.assetType==="CRYPTO"}>Stop</option></select></label>
              <label className="account-label">Order amount (USD)<input className="input" type="number" min={side==="BUY"?MINIMUM_ORDER_NOTIONAL_USD:"0.00000001"} step={side==="BUY"?"0.01":"any"} inputMode="decimal" required value={orderAmount} onChange={(event) => setOrderAmount(event.target.value)} placeholder="50.00"/></label>
              <p className="trade-estimate-note">{side==="BUY"?"Minimum $50.":"Partial sells must be at least $50; full available-asset sales may be smaller. Sell quantity is capped at available holdings."} Estimated quantity: {requestedQuantity.toLocaleString(undefined,{maximumFractionDigits:10})} {selectedBaseCurrency}.</p>
              {type !== "MARKET" && <label className="account-label">{type === "STOP" ? translate('stopPrice') : translate('limitPrice')}<input className="input" type="number" min="0.00000001" step="any" inputMode="decimal" required value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.00"/></label>}
              <div className="trade-estimate" aria-live="polite"><div><span>Available Aurevia wallet · {accountMode} · {accountMode==='REAL'?tradeWalletCurrency:'USD'}</span><b>{availableTradeBalance===null?"Loading…":formatWalletAmount(availableTradeBalance,accountMode==='REAL'?tradeWalletCurrency:'USD')}</b></div>{accountMode==='REAL'&&<><div><span>Reserved {side==='BUY'?'funds':'assets'} · {tradeWalletCurrency}</span><b>{formatWalletAmount(reservedTradeBalance,tradeWalletCurrency)}</b></div><div><span>Available to trade · {tradeWalletCurrency}</span><b>{formatWalletAmount(availableTradeBalance,tradeWalletCurrency)}</b></div>{side==='SELL'&&<div><span>Available quantity to sell</span><b>{availableSellQuantity.toLocaleString(undefined,{maximumFractionDigits:8})} {tradeWalletCurrency}</b></div>}<div><span>Aurevia simulated execution price</span><b>{formatWalletAmount(estimatedPrice,selectedQuoteCurrency)}</b></div></>}<div><span>{side==='BUY'?'Estimated required funds':'Estimated net proceeds'} · {accountMode==='REAL'?selectedQuoteCurrency:'USD'}</span><b>{formatWalletAmount(estimatedTradeValue,accountMode==='REAL'?selectedQuoteCurrency:'USD')}</b></div><div><span>{translate('estimatedFee')}</span><b>{cur?.takerFee===undefined?"Not configured":formatWalletAmount(estimatedFee,accountMode==='REAL'?selectedQuoteCurrency:'USD')}</b></div></div>
              <p className="trade-estimate-note">{accountMode==='REAL'?'Trade your funds and earn big':'Quotes, order matching, positions, and P/L are for practice and isolated to your DEMO account.'}</p>
              <button type="submit" disabled={placing||!selected||!cur||!realExecutionQuoteFresh||!Number.isFinite(orderAmountUsd)||(side==="BUY"&&orderAmountUsd<MINIMUM_ORDER_NOTIONAL_USD)||(side==="SELL"&&orderAmountUsd<MINIMUM_ORDER_NOTIONAL_USD&&requestedQuantity<availableSellQuantity)||!requestedQuantity||requestedQuantity>1_000_000_000} className="btn w-full bg-gold text-black disabled:opacity-50">{placing?translate('submittingOrder'):translate('placeOrder',{side})}</button>
              </fieldset>
              {message&&<div className={`trade-message is-${message.kind}`} role={message.kind==='error'?'alert':'status'}><span className="trade-message-icon">{message.kind==='success'?<CheckCircle2 size={17}/>:<AlertCircle size={17}/>}</span><p>{message.text}</p><button type="button" aria-label="Dismiss message" onClick={()=>setMessage(null)}><X size={16}/></button></div>}
            </form>
            <div className="mt-6">
              <h3 className="font-bold">Open orders</h3>
              {orders.filter((o) => o.status === "OPEN"||o.status==="PARTIALLY_FILLED").length ? (
                orders
                  .filter((o) => o.status === "OPEN"||o.status==="PARTIALLY_FILLED")
                  .map((o) => (
                    <div
                      key={o.id}
                      className="flex justify-between border-b border-white/10 py-2 text-xs"
                    >
                      <span>
                        {o.instrument.symbol} {o.side} {o.type}
                      </span>
                      <button type="button" onClick={() => cancel(o.id)} className="gold">
                        {translate('cancel')}
                      </button>
                    </div>
                  ))
              ) : (
                <p className="mt-2 muted text-sm">{translate('noOpenOrders')}</p>
              )}
            </div>
          </section>
        </div>
        <section className="card mt-4 p-5">
          <div className="account-panel-title"><div><h2>{translate('openPositions')}</h2><p className="account-panel-subtitle">{translate('unrealizedPnl')} · {accountMode==='REAL'?'P/L requires a current market quote':'DEMO positions'}</p></div><span className="status-pill">{positions.length} open</span></div>
          {positions.length ? (
            <div className="mt-3 space-y-2">
              {positions.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 py-3"
                >
                  <span>
                    {p.instrument.symbol} · {p.side} · {p.quantity}
                  </span>
                  <span className={pnl(p)===null?"muted":pnl(p)! >= 0 ? "text-profit" : "text-loss"}>
                    {pnl(p)===null?"P/L unavailable":`${pnl(p)! >= 0 ? "+" : ""}$${pnl(p)!.toFixed(2)}`}
                  </span>
                  <button type="button" disabled={p.requiresSellOrder||accountMode==='REAL'&&!items.some(item=>item.id===p.instrumentId&&!!item.liveQuote&&Number.isFinite(clock-Date.parse(item.liveQuote.updatedAt))&&clock-Date.parse(item.liveQuote.updatedAt)>=-5_000&&clock-Date.parse(item.liveQuote.updatedAt)<=30_000)} className="btn bg-loss disabled:opacity-50" onClick={() => void close(p.id)}>
                    {p.requiresSellOrder?'Legacy provider holding':accountMode==='REAL'?'Close internally':translate('close')}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 muted">{translate('noOpenPositions')}</p>
          )}
        </section>
        <section className="account-panel trade-history-card card mt-4 p-5"><div className="account-panel-title"><div><h2>{translate('orderHistory')}</h2><p className="account-panel-subtitle">{translate('recentSubmittedOrders')}</p></div><button type="button" className="trade-clear-failed" onClick={clearFailedOrders} disabled={!visibleFailedOrders.length} aria-label={`Clear ${visibleFailedOrders.length} failed orders from this view`}><X size={14}/> Clear failed orders{visibleFailedOrders.length>0&&<span>{visibleFailedOrders.length}</span>}</button></div>
          {visibleOrderHistory.length?<div className="account-table-wrap"><table className="account-table"><thead><tr><th>Instrument</th><th>Side</th><th>Type</th><th>Quantity</th><th>Limit / stop</th><th>Status</th></tr></thead><tbody>{visibleOrderHistory.slice(0,20).map(order=><tr key={order.id}><td>{order.instrument.symbol}</td><td>{order.side}</td><td>{order.type}</td><td>{Number(order.quantity).toLocaleString()}</td><td>{order.type==='LIMIT'?Number(order.price||0).toLocaleString(undefined,{maximumFractionDigits:6}):order.type==='STOP'?Number(order.stopPrice||0).toLocaleString(undefined,{maximumFractionDigits:6}):translate('market')}</td><td><span className={`status-pill trade-order-status is-${order.status.toLowerCase()}`}>{order.status.replaceAll('_',' ')}</span></td></tr>)}</tbody></table></div>:<div className="account-empty">{orders.length? 'Failed orders have been cleared from this view. The order records remain available in your account history.':translate('noOrdersRecorded')}</div>}
        </section>
        </>:<div className="account-empty" role="status">{translate('restoringAccountSession')}</div>}
      </main>
    </div>
  );
}
