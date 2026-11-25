import type {ReactNode} from 'react';

export function EmptyState({title,description,action}:{title:string;description?:string;action?:ReactNode}){
	return <div className="aurevia-empty-state" role="status">
		<span className="aurevia-empty-state-mark" aria-hidden="true"/>
		<h3>{title}</h3>
		{description&&<p>{description}</p>}
		{action&&<div className="aurevia-empty-state-action">{action}</div>}
	</div>;
}
