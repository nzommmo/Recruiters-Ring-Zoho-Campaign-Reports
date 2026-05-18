import React from 'react'
import ZohoCampaignsDashboard from './components/ZohoCampaignsDashboard'

const App = () => {
  return (
    <>
      {/* With mock data (safe for dev): */}
      {/* <ZohoCampaignsDashboard useMock={true} /> */}

      {/* With live Zoho API: */}
        <ZohoCampaignsDashboard useMock={false} />
    </>
  )
}

export default App