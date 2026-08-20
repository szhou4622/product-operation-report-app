import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('界面异常已被安全拦截', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="activation-screen">
        <div className="activation-card activation-loading" role="alert">
          <h1>界面暂时没有加载成功</h1>
          <p>资料和报告仍保存在本机。请点击下面的按钮重新加载，不需要重新安装软件。</p>
          <button className="btn primary" type="button" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
        </div>
      </div>
    )
  }
}
