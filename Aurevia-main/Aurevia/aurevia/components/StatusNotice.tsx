import {CheckCircle2,CircleX,Clock3,Info,LoaderCircle,RefreshCw} from 'lucide-react';

type StatusNoticeTone='success'|'declined'|'pending'|'attention'|'neutral';

type StatusNoticeProps={
	tone:StatusNoticeTone;
	title:string;
	description?:string;
	emoji?:string;
	processing?:boolean;
	role?:'status'|'alert';
};

const icons={
	success:CheckCircle2,
	declined:CircleX,
	pending:Clock3,
	attention:RefreshCw,
	neutral:Info,
};

export default function StatusNotice({tone,title,description,emoji,processing=false,role='status'}:StatusNoticeProps){
	const Icon=processing?LoaderCircle:icons[tone];

	return <div className={`status-notice status-notice--${tone}`} role={role} aria-live={role==='alert'?'assertive':'polite'}>
		<Icon className={`status-notice-icon${processing?' is-processing':''}`} size={21} aria-hidden="true"/>
		<div><h3>{title}</h3>{description&&<p>{description}</p>}</div>
		{emoji&&<span className="status-notice-emoji" aria-hidden="true">{emoji}</span>}
	</div>;
}
