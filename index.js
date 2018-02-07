require('./conf.js')

const readline = require('readline')
const fs = require('fs');
const redisClient = require('redis').createClient()

start()
async function start() {
    console.log('start')
    //清空缓存
    if (!await flashRedis())
        return console.log('redis flush all err!')
    console.log('flush all')

    //读取所有文件
    let files = loopDirGetFilename('原始数据/', [])

    //待解析经纬度总记录
    let lonlatCount = await filesToRedis(files)

    //解析经纬度
    await check(lonlatCount)

    //详细地址写入文件
    await writeFiles(files)
    console.log('end')
}

function flashRedis() {
    return new Promise((resolve, reject) => {
        redisClient.flushall((err, result) => {
            if (!err && result == 'OK') {
                resolve(true)
            }
            else {
                resolve(false)
            }
        })
    })
}

var lonlatCount_Copy = 0
async function filesToRedis(files) {
    let lonlatCount = 0
    for (let i = 0; i < files.length; i++) {
        let readFileName = files[i]
        lonlatCount = await fileToRedis(readFileName, lonlatCount)
    }
    return new Promise((resolve) => {
        let iii = setInterval(() => {
            if (lonlatCount_Copy == lonlatCount) {
                clearInterval(iii)
                console.log('所有经纬度写入redis')
                resolve(lonlatCount)
            }
        }, 20)
    })
}

function fileToRedis(readFileName, lonlatCount) {
    console.log('经纬度写入redis开始:' + readFileName)
    return new Promise((resolve, reject) => {
        let lastLonlat = ''
        readline.createInterface({ input: fs.createReadStream(readFileName) })
            .on('line', (line) => {
                var lonlat = /[\d.]*\s*,[\d.]*\s*$/.exec(line)//console.log(!!lonlat)
                if (!lonlat) return //console.log(line)

                lonlat = lonlat.toString().replace(/\s/g, '')
                if (lonlat == lastLonlat) return //console.log('cache hit')

                lastLonlat = lonlat
                redisClient.set(++lonlatCount, lonlat, () => { ++lonlatCount_Copy })
            })
            .on('close', () => {
                console.log(`经纬度写入redis结束:${readFileName}\n`)
                resolve(lonlatCount)
            })
    })
}

var getRequestCounter = 0
function detailAddressInRedis(tag) {
    redisClient.get(tag, function (err, lonlat) {
        if (err || !lonlat) {
            console.log(`严重错误! 从redis读取经纬度失败 tag:${tag}`)
            console.log(err)
            return
        }
        getRequestCounter++
        getPositons(lonlat)
    })
}

function check(lonlatCount) {
    console.log(`共${lonlatCount}条数据待解析`)
    return new Promise((resolve) => {
        let getRequestMax = 3
        let tag = 1
        var iii = setInterval(function () {
            if (tag > lonlatCount) {
                clearInterval(iii)
                console.log('read all lonlat from redis')
                resolve()
            }
            else if (getRequestCounter <= getRequestMax) {
                console.log(`${tag}/${lonlatCount} 并发请求数:${getRequestCounter} ${getSpeedAndNeedTime(lonlatCount - tag)}`)
                detailAddressInRedis(tag)
                tag++
            }
        }, 20)
    })
}

let arr = []
function getSpeedAndNeedTime(lonlatCount) {
    const divisor = 100
    let dateNow = Date.now()
    arr.push(dateNow)
    if (arr.length < divisor)
        return '剩余时间计算中...'
    let start = arr.shift()
    let speed = divisor / ((dateNow - start) / 1000)
    return `当前请求速度:${speed.toFixed(0)}条/s 剩余时间约:${getTimeBySecond((lonlatCount / speed).toFixed(0))}`
}

async function writeFiles(files) {
    for (let i = 0; i < files.length; i++) {
        let filename = files[i]
        await writeFile(filename)
    }
    console.log('所有文件写入完成!')
}

function writeFile(filename) {
    let writeFileName = filename.replace('原始数据/', '解析结果/')
    console.log('写文件开始:' + writeFileName)
    createDirByFilename(writeFileName)
    var fWrite = fs.createWriteStream(writeFileName);
    return new Promise((resolve, reject) => {
        var currentLine = 0
        readline.createInterface({ input: fs.createReadStream(filename) })
            .on('line', (line) => {
                if (++currentLine == 1) {
                    fWrite.write(new Buffer('\xEF\xBB\xBF', 'binary'));//add utf-8 bom
                    fWrite.write(line + ',程序解析详细地址')
                    return
                }
                var lonlat = /[\d.]*\s*,[\d.]*\s*$/.exec(line)
                if (!lonlat) return
                var key = 'key_' + lonlat.toString().replace(/\s/g, '')
                redisClient.get(key, function (err, value) {
                    if (err || (!value && value != ''))
                        console.log(`严重错误! 未从缓存读到数据 key:${key} readFileName:${filename} currentLine:${currentLine} line:${line} `)
                    else
                        fWrite.write(`\n${line},${value}`)
                })
            })
            .on('close', () => {
                setTimeout(function () {
                    fWrite.close(() => {
                        console.log('写文件结束:' + writeFileName)
                        resolve()
                    })
                }, 1000);
            })
    })
}

var request = require('request');
function getPositons(lonLats) {
    var url = `${conf.mapUrl}rgeocode/simple?resType=json&encode=utf-8&range=300&roadnum=3&crossnum=2&poinum=2&retvalue=1&key=55dc8b4eed5d8d2a32060fb80d26bf7310a6e4177224f997fc148baa0b7f81c1eda6fcc3fd003db0&sid=7001&region=${lonLats}&rid=967188`
    request(url, function (error, response, body) {
        if (error) {
            console.log(error)
            getPositons(lonLats)
        }
        else if (response && response.statusCode == 200) {
            getRequestCounter--
            redisClient.set('key_' + lonLats, getDetailAddressByOriginData(body))
        }
    })
}

function getDetailAddressByOriginData(originData) {
    if (!originData)
        return ''
    let mapData = originData.split("=")
    if (mapData.length < 2)
        return ''
    let jsonObj = JSON.parse(mapData[1])
    if (!jsonObj || !jsonObj.list)
        return ''
    var data = jsonObj.list
        .map(address => {
            var result = address.province.name + address.city.name + address.district.name
            if (address.poilist.length > 0) {
                result += address.poilist[0].name;
            }
            else if (address.roadlist.length > 0) {
                result += `${address.roadlist[0].name}${directionstr(address.roadlist[0].direction)}${address.roadlist[0].distance}m`;
            }
            return result
        })
    if (data && data.length > 0)
        return data[0]
    return ''
}

// var testOriginData = 'MMap.MAjaxResult[967188]={"time":"0.056","count":"2","status":"E0","list":[{"crosslist":[{"distance":"266.693","direction":"East","road1":{"id":"0731H49F0460402039","level":"42000","width":"12","name":"麓云路","ename":"Luyun Road"},"road2":{"id":"桐梓坡西路","level":"44000","width":"16","name":"桐梓坡西路","ename":"Tongzipo West Road"},"y":"28.22004806","x":"112.8815617"}],"poilist":[{"distance":"62.8539","typecode":"170200","pguid":"B02DB05L4H","address":"桐梓坡西路223号","direction":"North","tel":"","name":"长缆电缆附件有限公司","type":"公司企业;公司;公司","y":"28.220331","x":"112.878706"},{"distance":"260.528","typecode":"120302","pguid":"B02DB0TTOH","address":"中联重科斜对面","direction":"NorthWest","tel":"","name":"保利·麓谷林语","type":"商务住宅;住宅区;住宅小区","y":"28.22126","x":"112.876794"}],"province":{"name":"湖南省","ename":"Hunan Province","code":"430000"},"roadlist":[{"id":"桐梓坡西路","distance":"74.0351","level":"44000","direction":"North","width":"16","name":"桐梓坡西路","ename":"Tongzipo West Road","y":"28.2204","x":"112.879"},{"id":"麓云路","distance":"256.98","level":"42000","direction":"East","width":"12","name":"麓云路","ename":"Luyun Road","y":"28.2195","x":"112.881"}],"type":"list","district":{"name":"岳麓区","ename":"Yuelu District","code":"430104"},"near_districts":"","city":{"citycode":"0731","tel":"0731","name":"长沙市","ename":"Changsha City","code":"430100"}},{"crosslist":[{"distance":"266.693","direction":"East","road1":{"id":"0731H49F0460402039","level":"42000","width":"12","name":"麓云路","ename":"Luyun Road"},"road2":{"id":"桐梓坡西路","level":"44000","width":"16","name":"桐梓坡西路","ename":"Tongzipo West Road"},"y":"28.22004806","x":"112.8815617"}],"poilist":[{"distance":"62.8539","typecode":"170200","pguid":"B02DB05L4H","address":"桐梓坡西路223号","direction":"North","tel":"","name":"长缆电缆附件有限公司","type":"公司企业;公司;公司","y":"28.220331","x":"112.878706"},{"distance":"260.528","typecode":"120302","pguid":"B02DB0TTOH","address":"中联重科斜对面","direction":"NorthWest","tel":"","name":"保利·麓谷林语","type":"商务住宅;住宅区;住宅小区","y":"28.22126","x":"112.876794"}],"province":{"name":"湖南省","ename":"Hunan Province","code":"430000"},"roadlist":[{"id":"桐梓坡西路","distance":"74.0351","level":"44000","direction":"North","width":"16","name":"桐梓坡西路","ename":"Tongzipo West Road","y":"28.2204","x":"112.879"},{"id":"麓云路","distance":"256.98","level":"42000","direction":"East","width":"12","name":"麓云路","ename":"Luyun Road","y":"28.2195","x":"112.881"}],"type":"list","district":{"name":"岳麓区","ename":"Yuelu District","code":"430104"},"near_districts":"","city":{"citycode":"0731","tel":"0731","name":"长沙市","ename":"Changsha City","code":"430100"}}],"type":"list","version":"v2.0.0"}'
// console.log(getDetailAddressByOriginData(testOriginData))

function directionstr(oldstr) {
    switch (oldstr.toLowerCase()) {
        case "eastnorth": return "东北方"
        case "eastsouth": return "东南方"
        case "wstsouth": return "西南方"
        case "westnorth": return "西北方"
        case "northeast": return "东偏北"
        case "southeast": return "东偏南"
        case "southwest": return "西偏南"
        case "northwest": return "西偏北"
        case "north": return "正北方"
        case "east": return "正东方"
        case "south": return "正南方"
        case "west": return "正西方"
    }
    return ''
}

// 打印内存占用情况
function printMemoryUsage() {
    var info = process.memoryUsage()
    document.getElementById('memoryusage').innerHTML =
        `rss=${mb(info.rss)}<br/>
     heapTotal=${mb(info.heapTotal)}<br/>
     heapUsed=${mb(info.heapUsed)}`
}
function mb(v) {
    return (v / 1024 / 1024).toFixed(2) + 'MB';
}
setInterval(printMemoryUsage, 2000)

//-----------通用方法------------

function loopDirGetFilename(theDirPath, getfiles) {
    var files = fs.readdirSync(theDirPath)
    files.forEach(filename => {
        var stats = fs.statSync(theDirPath + filename)
        if (stats.isFile())
            getfiles.push(theDirPath + filename)
        if (stats.isDirectory())
            loopDirGetFilename(theDirPath + filename + '/', getfiles)
    })
    return getfiles
}

function createDirByFilename(filename, currentPath) {
    if (typeof filename != 'object') {
        filename = filename.split('/')
    } else {
        if (filename.length <= 1)
            return
    }
    currentPath = (currentPath || '') + filename.shift() + '/'
    if (!fs.existsSync(currentPath))
        fs.mkdirSync(currentPath)
    createDirByFilename(filename, currentPath)
}

function getTimeBySecond(ts) {
    var d = parseInt(ts / 86400)
    var h = parseInt((ts % 86400) / 3600)
    var m = parseInt((ts % 3600) / 60)
    var s = ts % 60;

    var result = '';
    if (d) result += d + '天';
    if (result || h) result += h + '时'
    if (result || m) result += m + '分'
    result += s + '秒'
    return result
}

//---------------excel todo-----------

function doTheJobByFilename(filename) {
    if (/.csv$/.test(filename)) {
        theJobCsv(filename)
    } else if (/.xls[x]?$/.test(filename)) {
        var jsonArr = GetJsonObjByExcel(filename)
        JsonObjToExcel(jsonArr, filename)
    }
}

// window.XLSX = require('./node_modules/xlsx/dist/xlsx.full.min.js')

function GetJsonObjByExcel(filename) {
    var workbook = XLSX.readFile(filename)
    var jsonObj = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])
    return jsonObj
}

function JsonObjToExcel(mapData2, filename) {
    var fenzus = [];
    const groupSize = 50;
    for (var i = 0; i < mapData2.length; i += groupSize) {
        fenzus.push(mapData2.slice(i, i + groupSize));
    }
    var functions = fenzus.map(m => {
        return getData(m)
    })
    Promise.all(functions).then(result => {
        result = result.map(m => {
            var fenzuObj = m[0]
            var fenzuAddress = JSON.parse(m[1].split("=")[1]).list
            for (var i = 0; i < m[0].length; i++) {
                var address = fenzuAddress[i]
                m[0][i]['详细地址'] = address.province.name + address.city.name + address.district.name
                if (address.poilist.length > 0) {
                    m[0][i]['详细地址'] += address.poilist[0].name;
                }
                else if (address.roadlist.length > 0) {
                    m[0][i]['详细地址'] += `${address.roadlist[0].name}${directionstr(address.roadlist[0].direction)}${address.roadlist[0].distance}m`;
                }
            }
            return m[0]
        })
        var bbb = [];
        for (var i = 0; i < result.length; i++) {
            bbb = bbb.concat(result[i])
        }
        saveJsonAsExcel(bbb, filename)
    })
}

function Workbook() {
    if (!(this instanceof Workbook)) return new Workbook();
    this.SheetNames = [];
    this.Sheets = {};
}

function saveJsonAsExcel(jsonObjs, excelName) {
    var wb = new Workbook()
    ws = XLSX.utils.json_to_sheet(jsonObjs);

    //计算列宽
    let colObj = {}
    jsonObjs.forEach(m => {
        for (let property in m) {
            if (!colObj[property])
                colObj[property] = property.replace(/[\u0391-\uFFE5]/g, "aa").length
        }

        for (let property in m) {
            let charLength = m[property].replace(/[\u0391-\uFFE5]/g, "aa").length
            if (charLength > colObj[property])
                colObj[property] = charLength
        }
    })
    let cols = []
    for (let i in colObj) {
        cols.push({ wpx: colObj[i] * 6.7 })
    }
    ws['!cols'] = cols;

    //sheet
    let ws_name = "SheetJS";
    wb.SheetNames.push(ws_name);
    wb.Sheets[ws_name] = ws;

    //路径
    excelName = excelName.replace('原始数据', '解析结果')
    createDirByFilename(excelName)


    //文件名
    var excelNameArr = excelName.split('.')
    excelNameArr[excelNameArr.length - 1] = 'xlsx'
    excelName = excelNameArr.join('.')

    XLSX.writeFile(wb, excelName);
}