const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const { rcedit } = await import('rcedit')
  const appInfo = context.packager.appInfo
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`)
  const iconPath = path.join(__dirname, 'icon.ico')

  await rcedit(exePath, {
    icon: iconPath,
    'file-version': appInfo.version,
    'product-version': appInfo.version,
    'version-string': {
      ProductName: appInfo.productName,
      FileDescription: appInfo.description,
      CompanyName: appInfo.companyName || appInfo.productName,
      InternalName: appInfo.productFilename,
      OriginalFilename: `${appInfo.productFilename}.exe`
    }
  })
}
